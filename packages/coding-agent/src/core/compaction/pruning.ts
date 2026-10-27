/**
 * Prune old tool results before compaction summarizes.
 *
 * A long unattended session carries the output of every tool call it ever made. Most of that
 * output is stale: the file was read once and edited later, or a status check printed the same
 * lines ten times. Replacing those results with a one-line stub removes their bytes from the
 * prompt without an LLM call. When the stub is enough to get the context under the compaction
 * threshold, no summarizer runs at all.
 *
 * The stub is written as a `context_edit` entry, which is the existing branch-local way to
 * replace model-visible content. Old session files do not change: they load as they are, and the
 * edits are appended only when a compaction runs.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import type { SessionEntry, SessionManager, SessionProjection } from "../session-manager.ts";
import { type CompactionSettings, prepareCompactionOrSkip } from "./compaction.ts";

/** Prefix of the one-line stub that replaces a pruned tool result. */
export const PRUNED_TOOL_RESULT_PREFIX = "[pruned tool result:";

export interface PrunableToolResult {
	/** Entry id of the tool result to replace. */
	entryId: string;
	toolName: string;
	/** Bytes of the tool result text that the stub replaces. */
	bytes: number;
	/** Turn number of the result, counted from user messages. */
	turn: number;
	/** The one-line text that replaces the result. */
	stub: string;
}

export interface ToolPruneResult {
	/** Tool results replaced by a stub. */
	pruned: number;
	/** Characters removed from the projected context. */
	charsSaved: number;
}

function isTurnStart(entry: SessionEntry): boolean {
	return entry.type === "message" && entry.message.role === "user";
}

/** Turn number of every entry, counted from user messages. Entries before the first user message are turn 0. */
function turnNumbers(pathEntries: SessionEntry[]): number[] {
	let turn = 0;
	return pathEntries.map((entry) => {
		if (isTurnStart(entry)) turn++;
		return turn;
	});
}

/** Index where the newest `keepTurns` turns start. The path length when no turn is kept. */
function turnBoundaryIndex(pathEntries: SessionEntry[], keepTurns: number): number {
	if (keepTurns <= 0) return pathEntries.length;
	const starts: number[] = [];
	for (let index = 0; index < pathEntries.length; index++) {
		if (isTurnStart(pathEntries[index])) starts.push(index);
	}
	const start = starts.length - keepTurns;
	if (start <= 0) return 0;
	return starts[start];
}

/**
 * Index of the first entry that `prepareCompaction()` would keep. Every tool result before it is
 * outside the kept tail. A preparation that keeps everything gives index 0, so nothing is pruned.
 */
function keptTailIndex(pathEntries: SessionEntry[], settings: CompactionSettings): number {
	const prepared = prepareCompactionOrSkip(pathEntries, settings);
	if (!("preparation" in prepared)) return 0;
	const index = pathEntries.findIndex((entry) => entry.id === prepared.preparation.firstKeptEntryId);
	return index < 0 ? 0 : index;
}

/** The one-line stub for a pruned tool result. It names the tool, the byte count, and the turn. */
export function formatPrunedToolResult(toolName: string, bytes: number, turn: number): string {
	return `${PRUNED_TOOL_RESULT_PREFIX} ${toolName}, ${bytes} bytes, turn ${turn}]`;
}

/**
 * Plan the tool results to prune. `compaction.keepRecentToolResults` sets how many of the newest
 * turns keep their tool results. Unset, the kept tail of `prepareCompaction()` decides: every
 * result outside it is prunable, which is exactly the range the summarizer would have read.
 */
export function planToolResultPrune(
	pathEntries: SessionEntry[],
	projection: SessionProjection,
	settings: CompactionSettings,
): PrunableToolResult[] {
	const boundary =
		settings.keepRecentToolResults !== undefined
			? turnBoundaryIndex(pathEntries, settings.keepRecentToolResults)
			: keptTailIndex(pathEntries, settings);
	if (boundary <= 0) return [];

	const projectedMessages = new Map<string, AgentMessage[]>();
	for (const entry of projection.entries) projectedMessages.set(entry.sourceEntry.id, entry.messages);
	const turns = turnNumbers(pathEntries);
	const candidates: PrunableToolResult[] = [];

	for (let index = 0; index < boundary; index++) {
		const entry = pathEntries[index];
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		// An entry before the newest compaction boundary is summarized away, so it is not sent and
		// needs no stub. A result an extension already replaced has no messages either.
		const messages = projectedMessages.get(entry.id);
		if (!messages || messages.length === 0) continue;
		const current = messages
			.filter((message) => message.role === "toolResult")
			.map((message) => contentText(message.content))
			.join("\n");
		if (current.length === 0 || current.startsWith(PRUNED_TOOL_RESULT_PREFIX)) continue;
		const bytes = Buffer.byteLength(current, "utf-8");
		const stub = formatPrunedToolResult(entry.message.toolName, bytes, turns[index]);
		// A stub longer than the result it replaces adds tokens instead of removing them.
		if (stub.length >= current.length) continue;
		candidates.push({ entryId: entry.id, toolName: entry.message.toolName, bytes, turn: turns[index], stub });
	}

	return candidates;
}

/**
 * Replace the planned tool results on the active branch with stubs, through `appendContextEdit()`.
 * Returns how many results were replaced and how many characters that removed.
 */
export function pruneToolResults(manager: SessionManager, settings: CompactionSettings): ToolPruneResult {
	const pathEntries = manager.getBranch();
	const projection = manager.buildSessionProjection();
	const candidates = planToolResultPrune(pathEntries, projection, settings);
	let charsSaved = 0;
	for (const candidate of candidates) {
		manager.appendContextEdit(candidate.entryId, { content: candidate.stub });
		charsSaved += candidate.bytes - candidate.stub.length;
	}
	return { pruned: candidates.length, charsSaved };
}
