import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { prepareCompactionOrSkip } from "../src/core/compaction/compaction.ts";
import {
	COMPACTION_FAILURE_CUSTOM_TYPE,
	type CompactionFailureData,
	failureModelFromError,
	failureReasonFromError,
	formatCompactionFailure,
	isCompactionFailureEntry,
	shouldRecordCompactionFailure,
} from "../src/core/compaction/failure.ts";
import { exportFromFile } from "../src/core/export-html/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { renderCompactionFailureEntry } from "../src/modes/interactive/components/compaction-failure-entry.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { createTestExtensionsResult } from "./utilities.ts";

const errorData: CompactionFailureData = {
	trigger: "threshold",
	outcome: "error",
	reason: "summarizer_error",
	errorMessage: "Summarization failed: boom",
	tokensBefore: 120_000,
	threshold: 114_688,
};

const skippedData: CompactionFailureData = {
	trigger: "threshold",
	outcome: "skipped",
	reason: "kept_window_exceeds_threshold",
};

function appendUser(manager: SessionManager, text: string): void {
	manager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
}

function appendAssistant(manager: SessionManager, text: string): void {
	manager.appendMessage(fauxAssistantMessage(text));
}

describe("compaction failure records", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
	});

	it("recognizes failure entries by type and data shape", () => {
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry(COMPACTION_FAILURE_CUSTOM_TYPE, errorData);
		manager.appendCustomEntry(COMPACTION_FAILURE_CUSTOM_TYPE, { broken: true });
		manager.appendCustomEntry("other", errorData);

		expect(manager.getEntries().map(isCompactionFailureEntry)).toEqual([true, false, false]);
	});

	it("dedupes error records per check cluster", () => {
		const manager = SessionManager.inMemory();
		appendUser(manager, "work");
		expect(shouldRecordCompactionFailure(manager.getBranch(), errorData)).toBe(true);
		manager.appendCustomEntry(COMPACTION_FAILURE_CUSTOM_TYPE, errorData);

		expect(shouldRecordCompactionFailure(manager.getBranch(), errorData)).toBe(false);
		expect(shouldRecordCompactionFailure(manager.getBranch(), { ...errorData, outcome: "cancelled" })).toBe(true);

		// Any newer entry ends the cluster, so the next failing turn records again.
		appendAssistant(manager, "tool turn");
		expect(shouldRecordCompactionFailure(manager.getBranch(), errorData)).toBe(true);
	});

	it("dedupes skipped and fallback records per episode", () => {
		const manager = SessionManager.inMemory();
		appendUser(manager, "work");
		manager.appendCustomEntry(COMPACTION_FAILURE_CUSTOM_TYPE, skippedData);
		appendAssistant(manager, "tool turn");

		expect(shouldRecordCompactionFailure(manager.getBranch(), skippedData)).toBe(false);
		expect(
			shouldRecordCompactionFailure(manager.getBranch(), { ...skippedData, reason: "nothing_to_summarize" }),
		).toBe(true);

		// A user message starts a new episode.
		appendUser(manager, "next");
		expect(shouldRecordCompactionFailure(manager.getBranch(), skippedData)).toBe(true);
		manager.appendCustomEntry(COMPACTION_FAILURE_CUSTOM_TYPE, skippedData);
		expect(shouldRecordCompactionFailure(manager.getBranch(), skippedData)).toBe(false);

		// So does a compaction.
		const firstKeptEntryId = manager.getBranch()[0]!.id;
		manager.appendCompaction("summary", firstKeptEntryId, 100);
		expect(shouldRecordCompactionFailure(manager.getBranch(), skippedData)).toBe(true);
	});

	it("reads the failure reason and model from a thrown error", () => {
		const unavailable = Object.assign(new Error("no auth"), {
			code: "compaction_model_unavailable",
			model: "openai/gpt-4o",
		});
		expect(failureReasonFromError(unavailable, "summarizer_error")).toBe("compaction_model_unavailable");
		expect(failureModelFromError(unavailable)).toBe("openai/gpt-4o");
		expect(failureReasonFromError(Object.assign(new Error("x"), { code: "ECONNRESET" }), "summarizer_error")).toBe(
			"summarizer_error",
		);
		expect(failureReasonFromError(new Error("boom"), "summarizer_error")).toBe("summarizer_error");
		expect(failureReasonFromError("boom", "cancelled")).toBe("cancelled");
		expect(failureModelFromError(new Error("boom"))).toBeUndefined();
	});

	it("tells skip reasons apart", () => {
		const settings = { enabled: true, reserveTokens: 100, keepRecentTokens: 1_000_000 };
		const manager = SessionManager.inMemory();
		appendUser(manager, "work");
		appendAssistant(manager, "answer");
		expect(prepareCompactionOrSkip(manager.getBranch(), settings)).toEqual({
			skipReason: "kept_window_exceeds_threshold",
		});

		// A retain-none compaction followed by a failure record leaves no message to keep or summarize.
		manager.appendCompaction("summary", null, 100);
		expect(prepareCompactionOrSkip(manager.getBranch(), settings)).toEqual({ skipReason: "nothing_to_summarize" });
		manager.appendCustomEntry(COMPACTION_FAILURE_CUSTOM_TYPE, skippedData);
		expect(prepareCompactionOrSkip(manager.getBranch(), settings)).toEqual({ skipReason: "nothing_to_summarize" });
	});

	it("formats one line with the token numbers when present", () => {
		expect(formatCompactionFailure(errorData)).toBe(
			"compaction failed (summarizer_error): Summarization failed: boom [tokens 120000, threshold 114688]",
		);
		expect(formatCompactionFailure(skippedData)).toBe("compaction failed (kept_window_exceeds_threshold)");
	});

	it("renders a failure entry in the TUI as one line", () => {
		initTheme("dark");
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry(COMPACTION_FAILURE_CUSTOM_TYPE, errorData);
		const entry = manager.getEntries()[0];
		if (entry?.type !== "custom") throw new Error("expected custom entry");

		const component = renderCompactionFailureEntry(entry, { expanded: false }, theme);
		const lines = component?.render(200) ?? [];
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("compaction failed (summarizer_error): Summarization failed: boom");
	});

	it("rejects extension entry renderers for the reserved pi: prefix", async () => {
		await expect(
			createTestExtensionsResult([
				(pi) => {
					pi.registerEntryRenderer(COMPACTION_FAILURE_CUSTOM_TYPE, () => undefined);
				},
			]),
		).rejects.toThrow('uses the reserved "pi:" prefix');
	});

	it("exports a session with a failure entry to HTML", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-compaction-failure-"));
		tempDirs.push(dir);
		const manager = SessionManager.create(dir, dir);
		appendUser(manager, "work");
		appendAssistant(manager, "answer");
		manager.appendCustomEntry(COMPACTION_FAILURE_CUSTOM_TYPE, errorData);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("expected a session file");

		const outputPath = await exportFromFile(sessionFile, join(dir, "export.html"));

		const html = readFileSync(outputPath, "utf8");
		const encoded = html.match(/[A-Za-z0-9+/=]{200,}/g) ?? [];
		const sessionData = encoded
			.map((chunk) => Buffer.from(chunk, "base64").toString("utf8"))
			.find((text) => text.includes(COMPACTION_FAILURE_CUSTOM_TYPE));
		expect(sessionData).toContain("Summarization failed: boom");
	});
});
