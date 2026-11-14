import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { estimateProjectedContextTokens } from "../../../src/core/compaction/index.ts";
import type { CompactionEntry } from "../../../src/core/session-manager.ts";
import type { ExtensionFactory } from "../../../src/index.ts";
import { createHarness, type Harness } from "../harness.ts";

type SessionWithCompactionInternals = {
	_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
};

interface RecordedCompactionEvent {
	type: "session_before_compact" | "session_compact";
	reason: "manual" | "threshold" | "overflow" | "prune";
	willRetry: boolean;
}

function recordingExtension(recorded: RecordedCompactionEvent[]): ExtensionFactory {
	return (pi) => {
		pi.on("session_before_compact", async (event) => {
			recorded.push({ type: event.type, reason: event.reason, willRetry: event.willRetry });
			return {
				compaction: {
					summary: "summary from extension",
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					details: {},
				},
			};
		});
		pi.on("session_compact", async (event) => {
			recorded.push({ type: event.type, reason: event.reason, willRetry: event.willRetry });
		});
	};
}

function getLatestCompaction(harness: Harness): CompactionEntry {
	const entry = harness.sessionManager.getBranch().findLast((candidate) => candidate.type === "compaction");
	if (entry?.type !== "compaction") throw new Error("expected a compaction entry");
	return entry;
}

/** The persisted entry records the trigger and the estimated context right after the compaction. */
function expectPersistedReason(harness: Harness, reason: CompactionEntry["reason"]): void {
	const entry = getLatestCompaction(harness);
	expect(entry.reason).toBe(reason);
	expect(entry.tokensAfter).toBe(
		estimateProjectedContextTokens(
			harness.sessionManager.buildSessionProjection(),
			harness.sessionManager.getBranch(),
		).tokens,
	);
	expect(entry.tokensAfter).toBeGreaterThan(0);
}

async function createCompactionHarness(recorded: RecordedCompactionEvent[]): Promise<Harness> {
	const harness = await createHarness({
		settings: { compaction: { keepRecentTokens: 1 } },
		extensionFactories: [recordingExtension(recorded)],
	});
	harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
	await harness.session.prompt("first");
	await harness.session.prompt("second");
	return harness;
}

describe("issue #5217 compaction reason on extension events", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("reports manual reason for compact()", async () => {
		const recorded: RecordedCompactionEvent[] = [];
		const harness = await createCompactionHarness(recorded);
		harnesses.push(harness);

		await harness.session.compact();

		expect(recorded).toEqual([
			{ type: "session_before_compact", reason: "manual", willRetry: false },
			{ type: "session_compact", reason: "manual", willRetry: false },
		]);
		expectPersistedReason(harness, "manual");
	});

	it("reports threshold reason for auto-compaction", async () => {
		const recorded: RecordedCompactionEvent[] = [];
		const harness = await createCompactionHarness(recorded);
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await sessionInternals._runAutoCompaction("threshold", false);

		expect(recorded).toEqual([
			{ type: "session_before_compact", reason: "threshold", willRetry: false },
			{ type: "session_compact", reason: "threshold", willRetry: false },
		]);
		expectPersistedReason(harness, "threshold");
	});

	it("reports overflow reason and willRetry for overflow recovery", async () => {
		const recorded: RecordedCompactionEvent[] = [];
		const harness = await createCompactionHarness(recorded);
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await sessionInternals._runAutoCompaction("overflow", true);

		expect(recorded).toEqual([
			{ type: "session_before_compact", reason: "overflow", willRetry: true },
			{ type: "session_compact", reason: "overflow", willRetry: true },
		]);
		expectPersistedReason(harness, "overflow");
	});

	it("records extension reason for boundary compaction drafts", async () => {
		let handled = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", () => {
						if (handled) return undefined;
						handled = true;
						return { entries: [{ type: "compaction", summary: "boundary summary", firstKeptEntryId: null }] };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one")]);
		await harness.session.prompt("first");

		const entry = getLatestCompaction(harness);
		expect(entry).toMatchObject({ summary: "boundary summary", fromHook: true, reason: "extension" });
		expect(entry.tokensAfter).toBeGreaterThan(0);
	});
});
