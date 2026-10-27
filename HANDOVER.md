# HANDOVER: stall-batch1

Written 2026-10-27 because the session context passed 60 percent. The batch is complete. All four
items are committed, tested, and replayed. Nothing is left running.

## Where

- Worktree: `~/projects/pi/.worktrees/stall-batch1`
- Branch: `teamlewis/stall-batch1`, from `teamlewis/compaction` at `757a61f39`
- Commits, one per item:
  - 1 result size cap: `b6800e3a4`
  - 2 duplicate-read stub: `049f0a1c2`
  - 3 edit error text: `c4b9beedd`
  - 4 mid-task end record: `88043d6bf`
- Not pushed. The lead decides the merge to `teamlewis/compaction`.

## What each item does

1. `tools.maxResultChars` (default 20,000) caps one `read`, `bash`, or `powershell` result. The
   result keeps its head and its tail, with one marker line between them that gives the omitted
   byte count and the temp file that holds the full output. The output accumulator writes that temp
   file as soon as the budget is exceeded, so the head comes from the start of the output.
2. The `read` tool keeps a per-session map of path to mtime, size, line count, turn, offset, and
   limit. A repeated read of the same range with no change returns two lines: the line count, the
   turn of the last read, and that `force: true` re-reads the text.
3. A duplicate edit match reports the line numbers of up to five occurrences and marks that more
   exist. A missing match reports the three nearest lines, each snippet bounded to 120 characters.
   There is no retry. A trailing-space difference still succeeds through the existing fuzzy match.
4. At `agent_end`, Pi appends a `custom` entry `pi:run_ended_mid_task` when the newest entry is a
   tool result, an assistant turn with tool calls and no text, or an assistant turn with no text
   that stopped on aborted, error, or length. The entry is a record only. It never enters model
   context and nothing retries. A run that will retry records nothing.

## Tests

- `npm run check`: exit 0, no errors, warnings, or infos.
- New tests: 6 for the result cap, 4 for the read stub, 5 for the edit errors, 8 unit and 3 suite
  for the run-end record. All pass.
- `./test.sh` on this worktree: coding-agent 2801 pass, 50 skipped, 11 fail. All 11 are the `find`
  tests that need the `fd` binary, which this server does not have. This matches the DESIGN.md
  baseline. Other packages fail for environment reasons that also fail on the base worktree: the
  `packages/env` daemon is not built, and a few timing tests are flaky.

## Replay

A read-only script loaded 325 of 326 session files under `~/.pi/agent/sessions` (206 MB, 60,649
entries) with the new code. Session `01a130ab-b0c0-73dc-abaf-980947761662` was skipped in code. No
file failed to load. No entry type was unknown. No custom entry entered the model projection. Old
session files load unchanged.

## Environment notes

This worktree started without `node_modules`, generated model data, or built `dist`. To run the
tests, the worktree needed:

- `npm install --ignore-scripts` (the lockfile change from this install was reverted, so it is not
  in any commit)
- a copy of `packages/ai/src/providers/data` from `.worktrees/integrate` (gitignored)
- a copy of the `dist` directories of the other packages from `.worktrees/integrate` (gitignored)

None of these are committed. A fresh worktree needs the same steps.

## Not built, as the brief says

The python tool (3.2), the failover model (3.5), the wait tool (3.4), and C10 to C14. Tim decides
those.
