import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

function getReadResults(harness: Harness): string[] {
	return harness.session.messages
		.filter((message) => message.role === "toolResult" && message.toolName === "read")
		.map((message) => getMessageText(message));
}

describe("repeated read stub", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function createReadHarness(): Promise<{ harness: Harness; path: string }> {
		const harness = await createHarness();
		harnesses.push(harness);
		const path = join(harness.tempDir, "notes.txt");
		writeFileSync(path, "alpha\nbeta\n");
		return { harness, path };
	}

	it("answers a repeated read of an unchanged file with a stub", async () => {
		const { harness, path } = await createReadHarness();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("read", { path })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("read it");

		const results = getReadResults(harness);
		expect(results).toHaveLength(2);
		expect(results[0]).toContain("alpha");
		expect(results[1]).toBe(
			"Unchanged since the last read (turn 1): 3 lines.\nPass force: true to read the text again.",
		);
	});

	it("returns the text again with force: true", async () => {
		const { harness, path } = await createReadHarness();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("read", { path, force: true })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("read it");

		const results = getReadResults(harness);
		expect(results[1]).toContain("alpha");
		expect(results[1]).toContain("beta");
	});

	it("returns the text when the file changed since the last read", async () => {
		const { harness, path } = await createReadHarness();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("read it");

		writeFileSync(path, "alpha\nbeta\ngamma\n");
		utimesSync(path, new Date(), new Date(Date.now() + 5_000));
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("read it again");

		const results = getReadResults(harness);
		expect(results).toHaveLength(2);
		expect(results[1]).toContain("gamma");
	});

	it("returns the text when the range differs", async () => {
		const { harness, path } = await createReadHarness();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("read", { path, offset: 2 })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("read it");

		const results = getReadResults(harness);
		expect(results[1]).not.toContain("Unchanged since the last read");
		expect(results[1]).toContain("beta");
	});
});
