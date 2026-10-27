/**
 * Durable compaction failure records.
 *
 * A failed, cancelled, or skipped compaction appends a `custom` session entry with
 * customType `pi:compaction_failure`. Custom entries never enter model context, so the
 * record changes nothing the model sees. It keeps the failure in the session file, where
 * the TUI, headless modes, and log analysis can find it after a resume.
 */

import type { CustomEntry, SessionEntry } from "../session-manager.ts";

/** customType of the durable failure record. The `pi:` prefix is reserved for core. */
export const COMPACTION_FAILURE_CUSTOM_TYPE = "pi:compaction_failure";

/** Prefix of custom entry types that only core may render. */
export const RESERVED_CUSTOM_TYPE_PREFIX = "pi:";

/** What started the compaction. Same values as the existing compaction_start event `reason`. */
export type CompactionTrigger = "manual" | "threshold" | "overflow" | "extension" | "prune";

export type CompactionFailureOutcome =
	| "error" // summarizer threw, provider error, handler threw, invalid result
	| "cancelled" // aborted by the user or a signal
	| "skipped" // over threshold but prepareCompaction() returned undefined
	| "timeout" // reserved for C11 (handler timeout); not emitted in Tier 1
	| "fallback"; // C5: compaction model did not fit, session model ran instead

export type CompactionFailureReason =
	| "summarizer_error"
	| "empty_summary" // C2
	| "invalid_extension_result" // C2
	| "kept_window_exceeds_threshold" // C1 silent skip
	| "nothing_to_summarize" // C1 silent skip
	| "cancelled"
	| "overflow_recovery_exhausted" // C1: the retry after one overflow recovery overflowed again
	| "compaction_model_window" // C5 window-fit guard
	| "compaction_model_unavailable"; // C5 missing model or auth

export interface CompactionFailureData {
	trigger: CompactionTrigger;
	outcome: CompactionFailureOutcome;
	reason: CompactionFailureReason;
	errorMessage?: string;
	tokensBefore?: number;
	contextWindow?: number;
	threshold?: number;
	attempt?: number;
	/** "provider/modelId" of the summarizer that was used or attempted. */
	model?: string;
	fromExtension?: boolean;
}

const COMPACTION_FAILURE_REASONS: ReadonlySet<string> = new Set<CompactionFailureReason>([
	"summarizer_error",
	"empty_summary",
	"invalid_extension_result",
	"kept_window_exceeds_threshold",
	"nothing_to_summarize",
	"cancelled",
	"overflow_recovery_exhausted",
	"compaction_model_window",
	"compaction_model_unavailable",
]);

/**
 * Failure reason of an error caught by a compaction path. An error object with a string `code`
 * that names a `CompactionFailureReason` supplies that reason. Any other error gives `fallback`.
 */
export function failureReasonFromError(error: unknown, fallback: CompactionFailureReason): CompactionFailureReason {
	if (typeof error !== "object" || error === null) return fallback;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" && COMPACTION_FAILURE_REASONS.has(code)
		? (code as CompactionFailureReason)
		: fallback;
}

/** `model` ("provider/modelId") of an error that carries one as a string, else undefined. */
export function failureModelFromError(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const model = (error as { model?: unknown }).model;
	return typeof model === "string" ? model : undefined;
}

/** Back-off constants (C4). */
export const COMPACTION_RETRY_GROWTH_MIN_TOKENS = 8192;
export const COMPACTION_RETRY_GROWTH_FRACTION = 0.05;
export const COMPACTION_MAX_CONSECUTIVE_FAILURES = 3;

function isCompactionFailureData(data: unknown): data is CompactionFailureData {
	if (typeof data !== "object" || data === null) return false;
	const record = data as Record<string, unknown>;
	return typeof record.trigger === "string" && typeof record.outcome === "string" && typeof record.reason === "string";
}

/** Whether `entry` is a `pi:compaction_failure` record with well-formed data. */
export function isCompactionFailureEntry(
	entry: SessionEntry,
): entry is CustomEntry<CompactionFailureData> & { data: CompactionFailureData } {
	return (
		entry.type === "custom" &&
		entry.customType === COMPACTION_FAILURE_CUSTOM_TYPE &&
		isCompactionFailureData(entry.data)
	);
}

function isUserMessageEntry(entry: SessionEntry): boolean {
	return entry.type === "message" && entry.message.role === "user";
}

/**
 * Whether a new failure record for `data` should be appended to `branch`.
 *
 * - `error`, `cancelled`, `timeout`: one record per check cluster. Skip when the newest
 *   entry is already a failure record with the same outcome and reason.
 * - `skipped`, `fallback`: one record per episode. Skip when a failure record with the
 *   same outcome and reason exists after the last compaction and the last user message.
 */
export function shouldRecordCompactionFailure(branch: SessionEntry[], data: CompactionFailureData): boolean {
	const matches = (entry: SessionEntry) =>
		isCompactionFailureEntry(entry) && entry.data.outcome === data.outcome && entry.data.reason === data.reason;
	if (data.outcome !== "skipped" && data.outcome !== "fallback") {
		const newest = branch[branch.length - 1];
		return newest === undefined || !matches(newest);
	}
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "compaction" || isUserMessageEntry(entry)) return true;
		if (matches(entry)) return false;
	}
	return true;
}

/** One-line text of a failure record, shared by the TUI renderer and the headless stderr line. */
export function formatCompactionFailure(data: CompactionFailureData): string {
	let text = `compaction failed (${data.reason})`;
	if (data.errorMessage) text += `: ${data.errorMessage}`;
	const numbers: string[] = [];
	if (data.tokensBefore !== undefined) numbers.push(`tokens ${data.tokensBefore}`);
	if (data.threshold !== undefined) numbers.push(`threshold ${data.threshold}`);
	if (numbers.length > 0) text += ` [${numbers.join(", ")}]`;
	return text;
}

/** Back-off state of threshold auto-compaction, derived from the session branch (C4). */
export interface CompactionBackoff {
	/** `error` and `timeout` records since the last compaction and the last user message. */
	consecutiveFailures: number;
	/** `tokensBefore` of the newest counted failure, when it recorded one. */
	lastFailureTokensBefore: number | undefined;
	/** Context size at which a retry is allowed again, when `lastFailureTokensBefore` is known. */
	retryAtTokens: number | undefined;
	/** True after `COMPACTION_MAX_CONSECUTIVE_FAILURES` failures: no threshold compaction until reset. */
	paused: boolean;
}

/**
 * Derive the threshold back-off from failure records on `branch`. The walk goes from the newest
 * entry back to the last compaction or the last user message, whichever is later, so a
 * successful compaction or a user message resets it. Only `error` and `timeout` count: a skip
 * is a budget problem and a cancellation is a user decision, not a summarizer failure.
 * The session file is the only state, so a resumed session derives the same back-off.
 */
export function deriveCompactionBackoff(branch: SessionEntry[], contextWindow: number): CompactionBackoff {
	let consecutiveFailures = 0;
	let lastFailureTokensBefore: number | undefined;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "compaction" || isUserMessageEntry(entry)) break;
		if (!isCompactionFailureEntry(entry)) continue;
		if (entry.data.outcome !== "error" && entry.data.outcome !== "timeout") continue;
		if (consecutiveFailures === 0) lastFailureTokensBefore = entry.data.tokensBefore;
		consecutiveFailures++;
	}
	const growth = Math.max(COMPACTION_RETRY_GROWTH_MIN_TOKENS, COMPACTION_RETRY_GROWTH_FRACTION * contextWindow);
	return {
		consecutiveFailures,
		lastFailureTokensBefore,
		retryAtTokens: lastFailureTokensBefore === undefined ? undefined : lastFailureTokensBefore + growth,
		paused: consecutiveFailures >= COMPACTION_MAX_CONSECUTIVE_FAILURES,
	};
}
