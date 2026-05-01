# AGENTS.md

Canonical project instructions live in `CLAUDE.md`.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->

---

## Using toolsmith MCP tools (for AI agents consuming this library)

### Anchor lifecycle

Anchors are **valid for the file version at read time**. Every line gets a stable opaque anchor (e.g. `Aabc123§const x = 1`) when you call `anchored_read` or `anchored_search`. That anchor is a contract: "this is that exact line in this version of the file."

**Anchors become stale when** another tool writes to the file, the user edits it in their editor, or you apply an edit. Unchanged lines keep their anchors after an edit; changed lines get new ones.

**Correct workflow:**
1. Call `anchored_read` (or `anchored_search`) to get anchors for the current version
2. Apply `anchored_edit` using those anchors
3. If you get a content mismatch or "not found" error — re-read the file and retry

### sessionId isolation

Use a consistent `sessionId` throughout a task. Anchors from session `"s1"` are invisible to session `"s2"`. Default is `"default"`.

### Recovering from errors

| Error | Cause | Fix |
|---|---|---|
| `no anchors registered…; call anchored_read first` | File never read in this session | Call `anchored_read` first |
| `not found in N current anchors; re-read the file if it has changed` | Stale anchor — file changed since read | Re-read and retry |
| `content mismatch; expected full reference Axyz§...` | Line content changed or wrong text | Copy the full `Anchor§line` reference exactly from the read output |

### Debugging anchor failures

Call `anchored_edit_status` to see which files and sessions have active anchors. If your file isn't listed, call `anchored_read` first.

### Large files

Files over 512KB are rejected. Use `startLine`/`endLine` for partial reads, `file_skeleton` for structure, or `get_function` for a single symbol.
