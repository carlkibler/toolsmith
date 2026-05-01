# AGENTS.md — toolsmith MCP guide for AI agents

## When to use toolsmith vs native tools

| Situation | Use |
|---|---|
| Edit code inside one named function/class | `symbol_replace` — no pre-read needed |
| Edit specific lines in a file >200 lines | `anchored_read` → `anchored_edit` |
| Edit lines matching a search pattern | `anchored_search` → `anchored_edit` |
| Explore an unfamiliar file's structure | `file_skeleton` |
| Read only one symbol from a large file | `get_function` → `anchored_edit` |
| Edit the same lines across multiple files | `anchored_edit_many` |
| File is small (<200 lines), one-off read | native Read is fine |

## Anchor lifecycle

Anchors are **valid for the file version at read time**. Every line gets a stable opaque anchor (e.g. `Aabc123§const x = 1`) when you call `anchored_read` or `anchored_search`. That anchor means: "this exact line in this version of the file."

**Anchors become stale when** the file is written by any tool or editor. Unchanged lines keep their anchors after an edit; changed lines get new ones.

**Correct workflow:**
1. Call `anchored_read`, `anchored_search`, or `get_function` to get anchors
2. Apply `anchored_edit` using those anchors immediately
3. On content mismatch or "not found" error — re-read and retry

## sessionId

Use a consistent `sessionId` throughout a task (e.g. your task name). Anchors from session `"s1"` are invisible to `"s2"`. Default is `"default"` — safe for single-task sessions.

## Error recovery

| Error | Cause | Fix |
|---|---|---|
| `no anchors registered…; call anchored_read first` | File never read in this session | Call `anchored_read` first |
| `not found in N current anchors` | Stale anchor — file changed since read | Re-read and retry |
| `content mismatch; expected full reference Axyz§...` | Wrong or incomplete anchor text | Copy the full `Anchor§line` exactly from read output |

## Debugging

Call `anchored_edit_status` to see which files and sessions have active anchors. If your file isn't listed, call `anchored_read` first.

## Large files

Files over 512KB are rejected. Use `startLine`/`endLine` for partial reads, `file_skeleton` for structure, or `get_function` for a single symbol.

---

## Project contributor notes

Canonical project instructions: `CLAUDE.md`. Issue tracking: `bd` (beads) — see `CLAUDE.md` for workflow.
