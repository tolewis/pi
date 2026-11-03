import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { detectRunEndedMidTask, isRunEndedMidTaskEntry } from "../src/core/run-end.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

function messageEntry(id: string, message: AgentMessage): SessionEntry {
	return { type: "message", id, parentId: null, timestamp: "2026-10-27T00:00:00.000Z", message };
}

function assistantWithToolCall(stopReason: AssistantMessage["stopReason"]) {
	return fauxAssistantMessage([fauxToolCall("bash", { command: "echo hi" })], { stopReason });
}

function toolResultEntry(id: string): SessionEntry {
	return messageEntry(id, {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "bash",
		content: [{ type: "text", text: "hi" }],
		isError: false,
		timestamp: 0,
	});
}

describe("detectRunEndedMidTask", () => {
	it("records a run that stopped on a tool result", () => {
		const branch = [messageEntry("a", assistantWithToolCall("toolUse")), toolResultEntry("b")];
		const record = detectRunEndedMidTask(branch, false);
		expect(record).toEqual({ reason: "killed", stopReason: "toolUse", pendingToolCall: true });
	});

	it("records an aborted run that stopped on a tool result", () => {
		const branch = [messageEntry("a", assistantWithToolCall("toolUse")), toolResultEntry("b")];
		expect(detectRunEndedMidTask(branch, true)?.reason).toBe("aborted");
	});

	it("records an assistant turn with tool calls and no text as the newest entry", () => {
		const branch = [messageEntry("a", assistantWithToolCall("toolUse"))];
		const record = detectRunEndedMidTask(branch, false);
		expect(record?.reason).toBe("killed");
		expect(record?.pendingToolCall).toBe(true);
	});

	it("uses the stop reason when the assistant turn stopped on length or error", () => {
		expect(detectRunEndedMidTask([messageEntry("a", assistantWithToolCall("length"))], false)?.reason).toBe("length");
		expect(detectRunEndedMidTask([messageEntry("a", assistantWithToolCall("error"))], false)?.reason).toBe("error");
	});

	it("records nothing when the run ended with assistant text", () => {
		const branch = [messageEntry("a", fauxAssistantMessage("all done"))];
		expect(detectRunEndedMidTask(branch, false)).toBeUndefined();
	});

	it("records an assistant turn with no text that stopped on error or length", () => {
		const error = detectRunEndedMidTask(
			[messageEntry("a", fauxAssistantMessage("", { stopReason: "error" }))],
			false,
		);
		expect(error).toEqual({ reason: "error", stopReason: "error", pendingToolCall: false });
		const length = detectRunEndedMidTask(
			[messageEntry("a", fauxAssistantMessage("", { stopReason: "length" }))],
			false,
		);
		expect(length).toEqual({ reason: "length", stopReason: "length", pendingToolCall: false });
	});

	it("records nothing when the newest entry is not a message", () => {
		const branch: SessionEntry[] = [
			messageEntry("a", assistantWithToolCall("toolUse")),
			{
				type: "custom",
				id: "b",
				parentId: "a",
				timestamp: "2026-10-27T00:00:00.000Z",
				customType: "pi:x",
				data: {},
			},
		];
		expect(detectRunEndedMidTask(branch, false)).toBeUndefined();
	});

	it("recognizes only well-formed records", () => {
		const record: SessionEntry = {
			type: "custom",
			id: "c",
			parentId: "b",
			timestamp: "2026-10-27T00:00:00.000Z",
			customType: "pi:run_ended_mid_task",
			data: { reason: "aborted", pendingToolCall: true },
		};
		expect(isRunEndedMidTaskEntry(record)).toBe(true);
		expect(
			isRunEndedMidTaskEntry({
				type: "custom",
				id: "d",
				parentId: "c",
				timestamp: "2026-10-27T00:00:00.000Z",
				customType: "pi:run_ended_mid_task",
				data: { reason: "aborted" },
			}),
		).toBe(false);
	});
});
