import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";

/** A predicate that fails on its first two runs and exits 0 on the third. */
function thirdRunPredicate(counterPath: string): string {
	return `n=$(cat '${counterPath}' 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > '${counterPath}'; test "$n" -ge 3`;
}

describe("wait tool", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function runWait(harness: Harness, args: { predicate: string; intervalMs?: number; timeoutMs?: number }) {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", args)], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("wait for it");
		return getToolResult(harness, "wait");
	}

	it("returns after about three intervals when the predicate passes on the third run", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const counterPath = join(harness.tempDir, "wait-count");

		const startedAt = Date.now();
		const result = await runWait(harness, {
			predicate: thirdRunPredicate(counterPath),
			intervalMs: 50,
			timeoutMs: 5_000,
		});
		const elapsed = Date.now() - startedAt;

		expect(result.isError).toBeFalsy();
		const text = getMessageText(result);
		expect(text).toContain("Predicate exited 0 after");
		expect(text).toContain("(3 runs)");
		// Two intervals of 50 ms pass between the first run and the third.
		expect(elapsed).toBeGreaterThanOrEqual(100);
		expect(readFileSync(counterPath, "utf-8").trim()).toBe("3");
	});

	it("returns an error result at the timeout when the predicate never passes", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const startedAt = Date.now();
		const result = await runWait(harness, { predicate: "false", intervalMs: 20, timeoutMs: 150 });
		const elapsed = Date.now() - startedAt;

		expect(result.isError).toBe(true);
		const text = getMessageText(result);
		expect(text).toContain("Predicate did not exit 0 within");
		expect(text).toContain("last exit code 1");
		// The wait stops near its budget and does not run for the default 120 seconds.
		expect(elapsed).toBeLessThan(2_000);
	});

	it("returns the predicate output with the seconds waited", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const result = await runWait(harness, {
			predicate: "echo ready; true",
			intervalMs: 100,
			timeoutMs: 2_000,
		});

		const text = getMessageText(result);
		expect(text.startsWith("ready\n")).toBe(true);
		expect(text).toContain("(1 run)");
	});
});
