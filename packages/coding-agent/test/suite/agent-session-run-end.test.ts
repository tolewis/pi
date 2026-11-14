import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { RUN_ENDED_MID_TASK_CUSTOM_TYPE } from "../../src/core/run-end.ts";
import { createHarness, type Harness } from "./harness.ts";

function echoTool(terminate: boolean): AgentTool {
	return {
		name: "echo",
		label: "Echo",
		description: "Echo text back",
		parameters: Type.Object({ text: Type.String() }),
		execute: async () => ({
			content: [{ type: "text", text: "ok" }],
			details: {},
			...(terminate ? { terminate: true } : {}),
		}),
	};
}

function runEndRecords(harness: Harness) {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === RUN_ENDED_MID_TASK_CUSTOM_TYPE);
}

describe("run ended mid-task record", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("records a run that stops on a tool result and stays out of context", async () => {
		// The tool ends the batch, so the run stops with its result as the newest entry.
		const harness = await createHarness({ tools: [echoTool(true)] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("late reply"),
		]);

		await harness.session.prompt("go");

		const records = runEndRecords(harness);
		expect(records).toHaveLength(1);
		expect(records[0].type === "custom" && records[0].data).toEqual({
			reason: "killed",
			stopReason: "toolUse",
			pendingToolCall: true,
		});

		// A custom entry never enters model context.
		expect(harness.session.messages.some((message) => message.role === "custom")).toBe(false);
	});

	it("records an aborted run that stops after a tool result", async () => {
		let abortRun: (() => void) | undefined;
		const abortingTool: AgentTool = {
			...echoTool(false),
			execute: async () => {
				abortRun?.();
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [abortingTool] });
		harnesses.push(harness);
		abortRun = () => {
			void harness.session.abort();
		};
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("late reply"),
		]);

		await harness.session.prompt("go");

		const records = runEndRecords(harness);
		expect(records).toHaveLength(1);
		expect(records[0].type === "custom" && records[0].data).toEqual({
			reason: "aborted",
			stopReason: "aborted",
			pendingToolCall: false,
		});
		expect(harness.session.messages.some((message) => message.role === "custom")).toBe(false);
	});

	it("records nothing when the run ends with assistant text", async () => {
		const harness = await createHarness({ tools: [echoTool(false)] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("all done"),
		]);

		await harness.session.prompt("go");

		expect(runEndRecords(harness)).toHaveLength(0);
	});
});
