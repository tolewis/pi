import { Text } from "@earendil-works/pi-tui";
import { formatCompactionFailure, isCompactionFailureEntry } from "../../../core/compaction/failure.ts";
import type { EntryRenderer } from "../../../core/extensions/types.ts";

/**
 * Core renderer of `pi:compaction_failure` entries: one line, red for failures, dim for
 * cancellations. The line is a session entry, so it survives re-renders and resume.
 */
export const renderCompactionFailureEntry: EntryRenderer = (entry, _options, theme) => {
	if (!isCompactionFailureEntry(entry)) return undefined;
	const color = entry.data.outcome === "cancelled" ? "dim" : "error";
	return new Text(theme.fg(color, formatCompactionFailure(entry.data)), 1, 0);
};
