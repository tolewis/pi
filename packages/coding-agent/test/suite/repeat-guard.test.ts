import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { FauxResponseStep } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const REPEAT_LINE = "This call repeats the previous call";

describe("repeat guard", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	function bashResults(harness: Harness): string[] {
		return harness.session.messages
			.filter((message) => message.role === "toolResult" && message.toolName === "bash")
			.map((message) => getMessageText(message));
	}

	it("adds one repeat line to each repeat and runs no extra turn", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const responses: FauxResponseStep[] = [];
		for (let index = 0; index < 20; index++) {
			responses.push(fauxAssistantMessage([fauxToolCall("bash", { command: "true" })], { stopReason: "toolUse" }));
		}
		responses.push(fauxAssistantMessage("done"));
		harness.setResponses(responses);

		await harness.session.prompt("repeat the same command");

		const results = bashResults(harness);
		expect(results).toHaveLength(20);
		// The first call is not a repeat. Every later identical call carries one line.
		expect(results[0]).not.toContain(REPEAT_LINE);
		for (const result of results.slice(1)) {
			expect(result.split(REPEAT_LINE)).toHaveLength(2);
			expect(result).toContain("wait");
		}
		// One assistant turn per response: the guard adds no turn.
		expect(harness.session.messages.filter((message) => message.role === "assistant")).toHaveLength(21);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("does not add the line after a previous error result", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "exit 3" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("bash", { command: "exit 3" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run a failing command twice");

		const results = bashResults(harness);
		expect(results).toHaveLength(2);
		expect(results[1]).not.toContain(REPEAT_LINE);
	});

	it("does not add the line when the repeat returned different output", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const counterPath = join(harness.tempDir, "counter");
		const command = `n=$(cat '${counterPath}' 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > '${counterPath}'; echo "$n"`;
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run the same command twice");

		const results = bashResults(harness);
		expect(results).toHaveLength(2);
		expect(results[1].trim()).toBe("2");
		expect(results[1]).not.toContain(REPEAT_LINE);
	});

	it("does not add the line when the arguments differ", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo one" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo two" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run two different commands");

		const results = bashResults(harness);
		expect(results).toHaveLength(2);
		expect(results[1]).not.toContain(REPEAT_LINE);
	});
});
