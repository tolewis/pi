import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
} from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { CompactionResult } from "../../src/core/compaction/index.ts";
import type { ExtensionError, SessionBeforeCompactEvent } from "../../src/core/extensions/index.ts";
import { createHarness, type Harness } from "./harness.ts";

type SessionWithCompactionInternals = {
	_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
};

type InvalidResultFactory = (event: SessionBeforeCompactEvent) => CompactionResult;

const DEFAULT_SUMMARY = "default summary from pi";

const invalidResults: Array<{ name: string; result: InvalidResultFactory; error: string }> = [
	{
		name: "an empty summary",
		result: (event) => ({
			summary: "  \n ",
			firstKeptEntryId: event.preparation.firstKeptEntryId,
			tokensBefore: event.preparation.tokensBefore,
		}),
		error: "Extension compaction result has an empty summary",
	},
	{
		name: "a firstKeptEntryId that is not on the branch",
		result: (event) => ({
			summary: "summary from extension",
			firstKeptEntryId: "not-on-branch",
			tokensBefore: event.preparation.tokensBefore,
		}),
		error: 'Extension compaction result firstKeptEntryId "not-on-branch" is not on the current branch',
	},
	{
		name: "tokensBefore NaN",
		result: (event) => ({
			summary: "summary from extension",
			firstKeptEntryId: event.preparation.firstKeptEntryId,
			tokensBefore: Number.NaN,
		}),
		error: "Extension compaction result tokensBefore NaN is not a finite number >= 0",
	},
];

function useSummaryStreamFn(harness: Harness): () => number {
	let callCount = 0;
	harness.session.agent.streamFunction = (model) => {
		callCount++;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const message: AssistantMessage = {
				...fauxAssistantMessage(DEFAULT_SUMMARY),
				api: model.api,
				provider: model.provider,
				model: model.id,
			};
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
	return () => callCount;
}

function seedCompactableSession(harness: Harness): void {
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to compact" }],
		timestamp: now - 1000,
	});
	harness.sessionManager.appendMessage({
		...fauxAssistantMessage("assistant response to compact", { timestamp: now - 500 }),
		api: harness.getModel().api,
		provider: harness.getModel().provider,
		model: harness.getModel().id,
	});
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "kept request" }],
		timestamp: now - 100,
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

async function createInvalidResultHarness(
	result: InvalidResultFactory,
): Promise<{ harness: Harness; errors: ExtensionError[]; getStreamCallCount: () => number }> {
	const harness = await createHarness({
		settings: { compaction: { keepRecentTokens: 1 } },
		extensionFactories: [
			(pi) => {
				pi.on("session_before_compact", async (event) => ({ compaction: result(event) }));
			},
		],
	});
	const errors: ExtensionError[] = [];
	harness.session.extensionRunner.onError((error) => errors.push(error));
	seedCompactableSession(harness);
	return { harness, errors, getStreamCallCount: useSummaryStreamFn(harness) };
}

function expectDefaultCompaction(harness: Harness, errors: ExtensionError[], error: string): void {
	const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
	expect(compactionEntries).toHaveLength(1);
	const entry = compactionEntries[0];
	if (entry?.type !== "compaction") throw new Error("expected a compaction entry");
	expect(entry.summary).toContain(DEFAULT_SUMMARY);
	expect(entry.fromHook).toBe(false);
	expect(entry.tokensBefore).toBeGreaterThanOrEqual(0);
	expect(harness.sessionManager.getEntry(entry.firstKeptEntryId)).toBeDefined();
	expect(errors).toEqual([expect.objectContaining({ event: "session_before_compact", error })]);

	const roles = harness.session.messages.map((message) => message.role);
	expect(roles).toContain("compactionSummary");
	expect(harness.session.messages.at(-1)).toMatchObject({ role: "user" });
}

describe("AgentSession extension compaction result validation", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	for (const invalid of invalidResults) {
		it(`manual compaction rejects ${invalid.name} and runs the default compaction`, async () => {
			const { harness, errors, getStreamCallCount } = await createInvalidResultHarness(invalid.result);
			harnesses.push(harness);

			const result = await harness.session.compact();

			expect(result.summary).toContain(DEFAULT_SUMMARY);
			expect(getStreamCallCount()).toBe(1);
			expectDefaultCompaction(harness, errors, invalid.error);
		});

		it(`auto-compaction rejects ${invalid.name} and runs the default compaction`, async () => {
			const { harness, errors, getStreamCallCount } = await createInvalidResultHarness(invalid.result);
			harnesses.push(harness);
			const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

			await sessionInternals._runAutoCompaction("threshold", false);

			expect(getStreamCallCount()).toBe(1);
			expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({ aborted: false });
			expect(harness.eventsOfType("compaction_end").at(-1)?.errorMessage).toBeUndefined();
			expectDefaultCompaction(harness, errors, invalid.error);
		});
	}
});
