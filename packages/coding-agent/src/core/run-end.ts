/**
 * Durable run-end records.
 *
 * A run that ends mid-task appends a `custom` session entry with customType
 * `pi:run_ended_mid_task`. Custom entries never enter model context, so the record changes nothing
 * the model sees. It keeps the reason in the session file, where the TUI, headless modes, and log
 * analysis can find it after a resume. The record is information only. It does not retry.
 */

import { contentText } from "@earendil-works/pi-ai";
import type { CustomEntry, SessionEntry } from "./session-manager.ts";

/** customType of the run-end record. The `pi:` prefix is reserved for core. */
export const RUN_ENDED_MID_TASK_CUSTOM_TYPE = "pi:run_ended_mid_task";

/** Why the run ended before the task did. */
export type RunEndedReason =
	| "aborted" // the user or a signal stopped the run
	| "error" // the provider returned an error
	| "length" // the output token limit stopped the reply
	| "killed"; // the loop stopped with no terminal stop reason, for example a closed pane

export interface RunEndedMidTaskData {
	reason: RunEndedReason;
	/** Stop reason of the last assistant message on the branch, when there is one. */
	stopReason?: string;
	/** True when a tool result or a tool call has no follow-up assistant turn. */
	pendingToolCall: boolean;
}

function isRunEndedMidTaskData(data: unknown): data is RunEndedMidTaskData {
	if (typeof data !== "object" || data === null) return false;
	const record = data as Record<string, unknown>;
	return typeof record.reason === "string" && typeof record.pendingToolCall === "boolean";
}

/** Whether `entry` is a `pi:run_ended_mid_task` record with well-formed data. */
export function isRunEndedMidTaskEntry(
	entry: SessionEntry,
): entry is CustomEntry<RunEndedMidTaskData> & { data: RunEndedMidTaskData } {
	return (
		entry.type === "custom" &&
		entry.customType === RUN_ENDED_MID_TASK_CUSTOM_TYPE &&
		isRunEndedMidTaskData(entry.data)
	);
}

function reasonFromStopReason(stopReason: string | undefined): RunEndedReason {
	if (stopReason === "error") return "error";
	if (stopReason === "length") return "length";
	if (stopReason === "aborted") return "aborted";
	return "killed";
}

/** Stop reason of the newest assistant message on `branch`. */
function lastAssistantStopReason(branch: SessionEntry[]): string | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "message" && entry.message.role === "assistant") {
			return entry.message.stopReason;
		}
	}
	return undefined;
}

/**
 * The record for a run that ended mid-task, or undefined when the run ended cleanly.
 *
 * A run ended mid-task when the newest entry is a tool result with no follow-up assistant turn, an
 * assistant turn with tool calls and no text, or an assistant turn with no text that stopped on
 * `aborted`, `error`, or `length`. Any other newest entry means the model spoke, which is a normal
 * end.
 */
export function detectRunEndedMidTask(
	branch: SessionEntry[],
	abortRequested: boolean,
): RunEndedMidTaskData | undefined {
	const last = branch[branch.length - 1];
	if (!last || last.type !== "message") return undefined;

	const message = last.message;
	if (message.role !== "toolResult" && message.role !== "assistant") return undefined;

	let pendingToolCall = message.role === "toolResult";
	if (message.role === "assistant") {
		const hasToolCall = message.content.some((block) => block.type === "toolCall");
		const hasText = contentText(message.content, "").trim().length > 0;
		const stoppedWithoutAnswer =
			message.stopReason === "aborted" || message.stopReason === "error" || message.stopReason === "length";
		if (hasText || (!hasToolCall && !stoppedWithoutAnswer)) return undefined;
		pendingToolCall = hasToolCall;
	}

	const stopReason = lastAssistantStopReason(branch);
	return {
		reason: abortRequested ? "aborted" : reasonFromStopReason(stopReason),
		...(stopReason === undefined ? {} : { stopReason }),
		pendingToolCall,
	};
}

/** One-line text of a run-end record. */
export function formatRunEndedMidTask(data: RunEndedMidTaskData): string {
	const stop = data.stopReason ? `, stop reason ${data.stopReason}` : "";
	return `run ended mid-task (${data.reason}${stop})`;
}
