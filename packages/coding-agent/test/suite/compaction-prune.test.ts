import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { PRUNED_TOOL_RESULT_PREFIX } from "../../src/core/compaction/pruning.ts";
import {
	buildSessionProjection,
	type CompactionEntry,
	loadEntriesFromFile,
	migrateSessionEntries,
	type SessionEntry,
} from "../../src/core/session-manager.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

type SessionWithCompactionInternals = {
	_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
};

function zeroUsage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistantMessage(text: string, totalTokens: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: zeroUsage(totalTokens),
		stopReason: "stop",
		timestamp: Date.now(),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
	};
}

/** Seed one task with a large tool result, then a second task, so the first result is outside the kept tail. */
function seedPrunableSession(harness: Harness, largeResultChars: number, keepTextChars: number): void {
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "first task" }],
		timestamp: now - 4000,
	});
	harness.sessionManager.appendMessage(assistantMessage("running the command", 500));
	harness.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "bash",
		content: [{ type: "text", text: "x".repeat(largeResultChars) }],
		isError: false,
		timestamp: now - 3000,
	});
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "k".repeat(keepTextChars) }],
		timestamp: now - 2000,
	});
	// The recorded usage covers everything before the edit, so the estimate falls back to chars/4
	// only after a context edit is appended.
	harness.sessionManager.appendMessage(assistantMessage("done", 12000));
	harness.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: "call-2",
		toolName: "bash",
		content: [{ type: "text", text: "small" }],
		isError: false,
		timestamp: now - 1000,
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

function runAutoCompaction(harness: Harness, reason: "overflow" | "threshold"): Promise<boolean> {
	return (harness.session as unknown as SessionWithCompactionInternals)._runAutoCompaction(reason, false);
}

function latestCompaction(harness: Harness): CompactionEntry | undefined {
	const entry = harness.sessionManager.getBranch().findLast((candidate) => candidate.type === "compaction");
	return entry?.type === "compaction" ? entry : undefined;
}

describe("prune old tool results before compaction", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("compacts by prune alone when the stubs bring the context under the threshold", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 100, reserveTokens: 120_000 } },
		});
		harnesses.push(harness);
		seedPrunableSession(harness, 40_000, 200);
		// A summary response is queued: if the summarizer ran, it would consume it.
		harness.setResponses([fauxAssistantMessage("summary that must not be used")]);

		await runAutoCompaction(harness, "threshold");

		const compaction = latestCompaction(harness);
		expect(compaction?.reason).toBe("prune");
		expect(typeof compaction?.tokensAfter).toBe("number");
		expect(compaction?.usage).toBeUndefined();
		expect(harness.getPendingResponseCount()).toBe(1);

		const edits = harness.sessionManager.getBranch().filter((entry) => entry.type === "context_edit");
		expect(edits).toHaveLength(1);
		const stub = harness.sessionManager
			.buildSessionProjection()
			.messages.filter((message) => message.role === "toolResult")
			.map((message) => getMessageText(message));
		expect(stub[0]?.startsWith(PRUNED_TOOL_RESULT_PREFIX)).toBe(true);
		expect(stub[0]).toContain("bash");
		expect(stub[0]).toContain("40000 bytes");
		expect(stub[0]).toContain("turn 1");
		// The conversation text is kept: the prune replaces tool output only.
		const texts = harness.sessionManager
			.buildSessionProjection()
			.messages.map((message) => getMessageText(message))
			.join("\n");
		expect(texts).toContain("first task");
		expect(texts).toContain("running the command");
	});

	it("goes on to the summarizer when the context is still over the threshold after prune", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 100, reserveTokens: 120_000 } },
		});
		harnesses.push(harness);
		// The kept text alone stays above the 8000-token threshold, so a summary is still needed.
		seedPrunableSession(harness, 40_000, 60_000);
		harness.setResponses([fauxAssistantMessage("summary of the older turns")]);

		await runAutoCompaction(harness, "threshold");

		const compaction = latestCompaction(harness);
		expect(compaction?.reason).toBe("threshold");
		expect(compaction?.usage).toBeDefined();
		expect(harness.getPendingResponseCount()).toBe(0);
		// The prune ran first, so the summarizer read stubs instead of the large result.
		const edits = harness.sessionManager.getBranch().filter((entry) => entry.type === "context_edit");
		expect(edits).toHaveLength(1);
	});

	it("loads a stock session fixture unchanged", () => {
		const fixturePath = join(__dirname, "..", "fixtures", "before-compaction.jsonl");
		const lines = readFileSync(fixturePath, "utf-8").split("\n").filter(Boolean);
		const entries = loadEntriesFromFile(fixturePath);
		const sessionEntries = entries.filter((entry): entry is SessionEntry => entry.type !== "session");
		migrateSessionEntries(sessionEntries);
		expect(sessionEntries.length).toBe(lines.length - 1);

		// Loading appends nothing: no prune edit, and the stored compaction entries stay as they are.
		expect(sessionEntries.some((entry) => entry.type === "context_edit")).toBe(false);
		const storedCompactions = lines.filter((line) => JSON.parse(line).type === "compaction").length;
		expect(sessionEntries.filter((entry) => entry.type === "compaction")).toHaveLength(storedCompactions);

		const projection = buildSessionProjection(sessionEntries);
		expect(projection.messages.length).toBeGreaterThan(0);
		expect(projection.messages.some((message) => getMessageText(message).includes(PRUNED_TOOL_RESULT_PREFIX))).toBe(
			false,
		);

		// A second load gives the same entries and the same projection.
		const reloaded = loadEntriesFromFile(fixturePath).filter(
			(entry): entry is SessionEntry => entry.type !== "session",
		);
		migrateSessionEntries(reloaded);
		expect(reloaded.map((entry) => entry.type)).toEqual(sessionEntries.map((entry) => entry.type));
		expect(reloaded.map((entry) => entry.timestamp)).toEqual(sessionEntries.map((entry) => entry.timestamp));
		expect(buildSessionProjection(reloaded).messages.length).toBe(projection.messages.length);
	});
});
