# AGENTS.md — toolsmith MCP guide for AI agents

## When to use toolsmith vs native tools

Default stance: if a file is likely over 200 lines and you are navigating code or making a surgical edit, use Toolsmith first. Native `Read`/`Edit`/`Write`, shell `cat`, `nl`, or broad `sed -n` are the fallback for genuinely small files, command output, or unavailable MCP tools.

| Situation | Use |
|---|---|
| Edit code inside one named function/class | `symbol_replace` — no pre-read needed |
| Edit specific lines in a file >200 lines | `anchored_read` → `anchored_edit` |
| Edit lines matching a search pattern | `anchored_search` → `anchored_edit` |
| Search across a directory before editing | `find_and_anchor` → `anchored_edit` |
| Explore an unfamiliar file's structure | `file_skeleton` |
| Read only one symbol from a large file | `get_function` → `anchored_edit` |
| Edit the same lines across multiple files | `anchored_edit_many` |
| File is small (<200 lines), one-off read | native Read is fine |
| Already used a native large-file read | switch to Toolsmith before editing so anchors and telemetry exist |

## Anchor lifecycle

Anchors are **valid for the file version at read time**. Every line gets a stable opaque anchor (e.g. `Aabc123§const x = 1`) when you call `anchored_read`, `anchored_search`, or `find_and_anchor`. That anchor means: "this exact line in this version of the file."

**Anchors become stale when** the file is written by any tool or editor. Unchanged lines keep their anchors after an edit; changed lines get new ones.

**Correct workflow:**
1. Call `anchored_read`, `anchored_search`, `find_and_anchor`, or `get_function` to get anchors
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

Files over 512KB are rejected. Use `startLine`/`endLine` for partial reads, `file_skeleton` for structure, `find_and_anchor` for repo/file search, or `get_function` for a single symbol.

---

## Project contributor notes

Canonical project instructions: `CLAUDE.md`. Issue tracking: `bd` (beads) — see `CLAUDE.md` for workflow.

<!-- toolsmith:begin -->
## Toolsmith MCP

Toolsmith is the default path for large-file code navigation and surgical edits when MCP tools are available. Use native Read/Edit/Write, shell `cat`, `nl`, or broad `sed -n` on files likely over 200 lines only when Toolsmith is unavailable or the file is genuinely small.

- Explore first: `mcp__toolsmith__file_skeleton`, `mcp__toolsmith__get_function`, or bounded `mcp__toolsmith__anchored_read`
- Search before editing: `mcp__toolsmith__find_and_anchor` or `mcp__toolsmith__anchored_search` instead of `rg` + `sed`/`cat`
- Edit with validation: `mcp__toolsmith__anchored_edit` / `mcp__toolsmith__anchored_edit_many`
- Single-symbol edits: `mcp__toolsmith__symbol_replace`
- If you already used a native large-file read, switch to Toolsmith before editing so anchors and telemetry exist

<!-- toolsmith:end -->
