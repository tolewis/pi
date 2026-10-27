import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { capResultChars } from "../../src/core/tools/truncate.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";

const BUDGET = 20_000;
const MARKER_PATTERN = /\[\.\.\. (\d+) bytes omitted\. Full output: (\S+) \.\.\.\]/;

describe("per-result character budget", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function runTool(harness: Harness, toolName: string, args: Record<string, string>) {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(toolName, args)], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("run");
		return getMessageText(getToolResult(harness, toolName));
	}

	it("caps a 200 KB bash result and keeps the full output in a temp file", async () => {
		const harness = await createHarness({ settings: { tools: { maxResultChars: BUDGET } } });
		harnesses.push(harness);

		const text = await runTool(harness, "bash", { command: "seq 1 40000" });

		const marker = text.match(MARKER_PATTERN);
		expect(marker).not.toBeNull();
		expect(text.length).toBeLessThanOrEqual(BUDGET + marker![0].length);
		// The head of the command output survives, not only the tail.
		expect(text.startsWith("1\n2\n")).toBe(true);
		expect(text.endsWith("40000\n")).toBe(true);

		const omittedBytes = Number(marker![1]);
		expect(omittedBytes).toBeGreaterThan(200_000);
		const fullOutput = readFileSync(marker![2], "utf-8");
		expect(fullOutput.startsWith("1\n2\n3\n")).toBe(true);
		expect(fullOutput.endsWith("39999\n40000\n")).toBe(true);
	});

	it("caps a bash result that is over the budget but under the byte truncation limit", async () => {
		const harness = await createHarness({ settings: { tools: { maxResultChars: BUDGET } } });
		harnesses.push(harness);

		const text = await runTool(harness, "bash", { command: "seq 1 6000" });

		const marker = text.match(MARKER_PATTERN);
		expect(marker).not.toBeNull();
		expect(text.length).toBeLessThanOrEqual(BUDGET + marker![0].length);
		expect(text.startsWith("1\n2\n")).toBe(true);
		expect(text.endsWith("6000\n")).toBe(true);
		expect(readFileSync(marker![2], "utf-8").endsWith("6000\n")).toBe(true);
	});

	it("caps a read result and keeps the full text in a temp file", async () => {
		const harness = await createHarness({ settings: { tools: { maxResultChars: BUDGET } } });
		harnesses.push(harness);

		// About 30 KB: over the character budget, but under the 50 KB and 2,000 line truncation limits.
		const content = Array.from({ length: 1000 }, (_, index) => `line ${index + 1} ${"x".repeat(20)}`).join("\n");
		const path = join(harness.tempDir, "big.txt");
		writeFileSync(path, content);

		const text = await runTool(harness, "read", { path });

		const marker = text.match(MARKER_PATTERN);
		expect(marker).not.toBeNull();
		expect(text.length).toBeLessThanOrEqual(BUDGET + marker![0].length);
		expect(text.startsWith("line 1 ")).toBe(true);
		expect(text.endsWith(`line 1000 ${"x".repeat(20)}`)).toBe(true);
		expect(readFileSync(marker![2], "utf-8")).toBe(content);
	});

	it("leaves a result under the budget unchanged", async () => {
		const harness = await createHarness({ settings: { tools: { maxResultChars: BUDGET } } });
		harnesses.push(harness);

		const text = await runTool(harness, "bash", { command: "echo small" });

		expect(text).not.toMatch(MARKER_PATTERN);
		expect(text).toContain("small");
	});
});

describe("capResultChars", () => {
	it("keeps the head and the tail around one marker line", () => {
		const content = `${"a".repeat(30_000)}${"b".repeat(30_000)}`;
		const capped = capResultChars(content, { maxChars: 1000, fullOutputPath: "/tmp/full.log" });

		expect(capped.truncated).toBe(true);
		expect(capped.content.startsWith("a".repeat(499))).toBe(true);
		expect(capped.content.endsWith("b".repeat(499))).toBe(true);
		expect(capped.content).toContain("bytes omitted. Full output: /tmp/full.log");
		expect(capped.content.length).toBe(1000 + capped.content.split("\n")[1].length);
	});

	it("returns the content unchanged when it fits or the budget is off", () => {
		expect(capResultChars("short", { maxChars: 100 }).truncated).toBe(false);
		expect(capResultChars("x".repeat(100), { maxChars: 0 }).content).toBe("x".repeat(100));
	});
});
