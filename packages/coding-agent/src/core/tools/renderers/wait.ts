/**
 * Presentation for the wait tool.
 *
 * Renderers live apart from the implementation so a process that only displays tool output does not
 * load the execution path or its typebox parameter schema. `wait.ts` spreads these into its
 * definition, so the tool's public shape is unchanged.
 */

import { Text } from "@earendil-works/pi-tui";
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../../extensions/types.ts";
import { getTextOutput, str } from "../render-utils.ts";
import type { WaitToolDetails } from "../wait.ts";

function formatWaitCall(
	args: { predicate?: string; intervalMs?: number; timeoutMs?: number } | undefined,
	theme: Theme,
): string {
	const predicate = str(args?.predicate);
	const predicateDisplay = predicate === null ? "" : predicate ? predicate : "...";
	const timeout = args?.timeoutMs;
	let text = `${theme.fg("toolTitle", theme.bold("wait"))} ${predicateDisplay}`;
	if (timeout !== undefined) text += theme.fg("muted", ` (timeout ${timeout}ms)`);
	return text;
}

function formatWaitResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: WaitToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	if (!output) return "";
	const lines = output.split("\n");
	const maxLines = options.expanded ? lines.length : 20;
	const displayLines = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	let text = `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
	if (remaining > 0) {
		text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
	}
	return text;
}

export const waitRenderers: Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> = {
	renderCall(args, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(formatWaitCall(args as any, theme));
		return text;
	},
	renderResult(result, options, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(formatWaitResult(result as any, options, theme, context.showImages));
		return text;
	},
};
