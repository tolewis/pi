# HANDOVER: stall-batch2

Written 2026-10-27 because the session context passed 60 percent. Both items in the brief are
committed, tested, and replayed. Nothing is left running.

## Where

- Worktree: `~/projects/pi/.worktrees/stall-batch2`
- Branch: `teamlewis/stall-batch2`, from `teamlewis/compaction` at `3bcff5ab2` (batch one merged)
- Commits, one per item:
  - 1 wait tool and repeat guard: `643041e65`
  - 2 prune old tool results before compaction: `3e945df85`
- Not pushed. The lead decides the merge to `teamlewis/compaction`.

## What each item does

1. A core `wait` tool runs a shell predicate every `intervalMs` (default 5000) until it exits 0 or
   `timeoutMs` passes (default 120000, maximum 600000). It returns the last predicate output and
   the seconds waited. It is on by default (`DEFAULT_TOOL_NAMES`), so the model can call it. The
   core tool retires the 60-second cap on `bash_wait` in the TeamLewis extension
   `teamlewis-bg-tools`, which this batch does not edit.
   The repeat guard records the previous tool call's name and arguments. A call that repeats them,
   when the previous result was not an error and the output is identical, gets one line on its
   result that names the repeat and the wait tool. A repeat that returned different output did
   real work and gets no line. Nothing blocks and nothing retries. Detection is in
   `_beforeToolCall`; the line is added in `_afterToolCall`.
2. `src/core/compaction/pruning.ts` plans and applies a prune of tool results older than the kept
   tail, through `appendContextEdit()`. Each stub names the tool, the byte count, and the turn.
   `compaction.keepRecentToolResults` sets how many of the newest turns keep their results; unset,
   the kept tail of `keepRecentTokens` decides. A stub longer than the result it replaces is
   skipped. When the stubs bring the projected context under the threshold, no summarizer runs and
   a compaction entry with `reason: "prune"` and `tokensAfter` is appended. That entry keeps the
   previous boundary and carries the previous summary forward, so no conversation text or summary
   is dropped. A still-over-threshold context goes on to the ordinary summarizer, which reads the
   stubs. Manual `/compact` does not prune. `CompactionTrigger`, the session events, the extension
   events, and the TUI status label accept `"prune"`.

## Tests

- `npm run check`: exit 0, no errors, warnings, or infos. `npm run generate:schemas` regenerated
  `schemas/settings.schema.json` for the new setting.
- New tests: 4 suite cases for the repeat guard, 3 suite cases for the wait tool, 3 suite cases for
  the prune path (prune alone with no summarizer call, still-over-threshold going on to the
  summarizer, a stock session fixture that loads unchanged). All pass.
- `./test.sh` on this worktree: coding-agent 2810 pass, 50 skipped, 11 fail. All 11 are the `find`
  tests that need the `fd` binary, which this server does not have. This matches the DESIGN.md
  baseline. Other packages fail for environment reasons that also fail on the base worktree: the
  `packages/env` daemon is not built.
- One existing characterization test changed: the oversized-tool-result compaction test now checks
  that the first compaction is `threshold`, because a later check can prune the same result when
  the summary alone leaves the context over the threshold.

## Replay

A read-only script loaded 545 of 550 session files under `~/.pi/agent/sessions` (299.9 MB, 77,050
entries) with the new code. The 5 skipped files are session `01a130ab-b0c0-73dc-abaf-980947761662`
and its four run directories. No file failed to load. No entry type was unknown. No prune stub
appeared in a loaded projection. 53 files already carry `context_edit` entries from the existing
overflow-recovery omission, and they load unchanged.

## Environment notes

This worktree needed the same setup as batch one: `node_modules` copied from another worktree,
`packages/ai/src/providers/data` and the `dist` directories copied from `.worktrees/integrate`, and
`packages/ai/node_modules` (the nested `openai` 7.19.0 that `tsc` needs). None of these are
committed.

## Not built, as the brief says

The python tool (3.2), the failover model (3.5), C11 to C14, and anything that keys on the model
id. Tim decides those.
