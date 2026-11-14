import type { AgentTool, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { type BashOperations, createLocalBashOperations } from "./bash.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { capResultChars } from "./truncate.ts";

/** Default pause between predicate runs. */
export const DEFAULT_WAIT_INTERVAL_MS = 5_000;
/** Default budget for the whole wait. */
export const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
/** Longest accepted budget for the whole wait. */
export const MAX_WAIT_TIMEOUT_MS = 600_000;
/** Characters kept from the last predicate output. */
const MAX_WAIT_OUTPUT_CHARS = 4_000;

const waitSchema = Type.Object({
	predicate: Type.String({
		description: "Shell command that exits 0 when the condition holds, for example a file test or a status check",
	}),
	intervalMs: Type.Optional(
		Type.Number({ description: `Milliseconds between runs of the predicate (default ${DEFAULT_WAIT_INTERVAL_MS})` }),
	),
	timeoutMs: Type.Optional(
		Type.Number({
			description: `Milliseconds before the wait gives up (default ${DEFAULT_WAIT_TIMEOUT_MS}, maximum ${MAX_WAIT_TIMEOUT_MS})`,
		}),
	),
});

export const waitToolSystemPromptContribution = {
	snippet: "Wait for a shell predicate to exit 0 instead of repeating a command",
	guidelines: [
		"When you need a change that another process makes, call wait with a predicate that exits 0 after the change instead of repeating the same command.",
	],
} as const;

export type WaitToolInput = Static<typeof waitSchema>;

export interface WaitToolDetails {
	/** Predicate runs that were made. */
	attempts: number;
	/** Whole seconds waited. */
	secondsWaited: number;
	/** Exit code of the last run, or null when the run failed without one. */
	lastExitCode: number | null;
}

export interface WaitToolOptions {
	/** Custom operations for command execution. Default: local shell. */
	operations?: BashOperations;
	/** Optional explicit shell path from settings. */
	shellPath?: string;
}

function resolveIntervalMs(intervalMs: number | undefined): number {
	const value = intervalMs ?? DEFAULT_WAIT_INTERVAL_MS;
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error("Invalid intervalMs: must be a finite number of milliseconds greater than 0");
	}
	return value;
}

function resolveTimeoutMs(timeoutMs: number | undefined): number {
	const value = timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error("Invalid timeoutMs: must be a finite number of milliseconds greater than 0");
	}
	if (value > MAX_WAIT_TIMEOUT_MS) {
		throw new Error(`Invalid timeoutMs: maximum is ${MAX_WAIT_TIMEOUT_MS} milliseconds`);
	}
	return value;
}

/** Resolve after `ms`, or reject with "aborted" when the signal fires first. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("aborted"));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(new Error("aborted"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** Collect the output of one predicate run, bounded to what the result can show. */
function createOutputCapture(): { onData: (data: Buffer) => void; text: () => string } {
	let text = "";
	return {
		onData: (data: Buffer) => {
			text += data.toString("utf-8");
			if (text.length > MAX_WAIT_OUTPUT_CHARS * 4) text = text.slice(-MAX_WAIT_OUTPUT_CHARS * 4);
		},
		text: () => text,
	};
}

function formatSeconds(ms: number): string {
	return (ms / 1000).toFixed(1);
}

export function createWaitToolDefinition(
	cwd: string,
	options?: WaitToolOptions,
): ToolDefinition<typeof waitSchema, WaitToolDetails> {
	return {
		name: "wait",
		label: "wait",
		description: `Run a shell predicate again every intervalMs milliseconds until it exits 0 or timeoutMs passes. Returns the last predicate output and the seconds waited. Use it instead of repeating the same command to poll for a change. Default intervalMs ${DEFAULT_WAIT_INTERVAL_MS}, default timeoutMs ${DEFAULT_WAIT_TIMEOUT_MS}, maximum timeoutMs ${MAX_WAIT_TIMEOUT_MS}.`,
		promptSnippet: waitToolSystemPromptContribution.snippet,
		promptGuidelines: [...waitToolSystemPromptContribution.guidelines],
		parameters: waitSchema,
		async execute(
			_toolCallId,
			{ predicate, intervalMs, timeoutMs }: WaitToolInput,
			signal?: AbortSignal,
			_onUpdate?: AgentToolUpdateCallback<WaitToolDetails>,
			ctx?: ExtensionContext,
		) {
			const interval = resolveIntervalMs(intervalMs);
			const budget = resolveTimeoutMs(timeoutMs);
			const ops = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
			const startedAt = Date.now();
			let attempts = 0;
			let lastOutput = "";
			let lastExitCode: number | null = null;

			while (true) {
				const remaining = budget - (Date.now() - startedAt);
				if (remaining <= 0) break;
				attempts++;
				const capture = createOutputCapture();
				let passed = false;
				try {
					const result = await ops.exec(predicate, ctx?.cwd || cwd, {
						onData: capture.onData,
						signal,
						timeout: remaining / 1000,
					});
					lastExitCode = result.exitCode;
					lastOutput = capture.text();
					passed = result.exitCode === 0;
				} catch (err) {
					if (err instanceof Error && err.message === "aborted") {
						throw new Error("Wait aborted");
					}
					const captured = capture.text();
					// A predicate that ran out the whole budget ends the wait. It keeps the last completed
					// run's output and exit code, so the result names the real outcome, not the timeout.
					if (err instanceof Error && err.message.startsWith("timeout:")) {
						if (captured) lastOutput = captured;
						break;
					}
					// Any other failure is one failed run, and the next interval follows.
					lastOutput = captured || (err instanceof Error ? err.message : "");
					lastExitCode = null;
				}

				const waitedMs = Date.now() - startedAt;
				if (passed) {
					const capped = capResultChars(lastOutput, { maxChars: MAX_WAIT_OUTPUT_CHARS });
					const output = capped.content;
					const line = `Predicate exited 0 after ${formatSeconds(waitedMs)} seconds (${attempts} ${attempts === 1 ? "run" : "runs"}).`;
					return {
						content: [{ type: "text", text: output ? `${output}\n\n${line}` : line }],
						details: { attempts, secondsWaited: waitedMs / 1000, lastExitCode },
					};
				}

				const sleepMs = Math.min(interval, budget - waitedMs);
				if (sleepMs <= 0) break;
				await sleep(sleepMs, signal);
			}

			const waitedMs = Date.now() - startedAt;
			const capped = capResultChars(lastOutput, { maxChars: MAX_WAIT_OUTPUT_CHARS });
			const output = capped.content;
			const exitText = lastExitCode === null ? "no exit code" : `last exit code ${lastExitCode}`;
			const line = `Predicate did not exit 0 within ${formatSeconds(waitedMs)} seconds (${attempts} ${attempts === 1 ? "run" : "runs"}, ${exitText}).`;
			return {
				content: [{ type: "text", text: output ? `${output}\n\n${line}` : line }],
				details: { attempts, secondsWaited: waitedMs / 1000, lastExitCode },
				isError: true,
			};
		},
	};
}

export function createWaitTool(cwd: string, options?: WaitToolOptions): AgentTool<typeof waitSchema> {
	const definition = createWaitToolDefinition(cwd, options);
	const tool = wrapToolDefinition(definition);
	Object.assign(tool, {
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
	});
	return tool;
}
