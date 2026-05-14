# Toolsmith Agent Guide

Portable core for hash-anchored, batched, low-token file edits across agent harnesses.

## Scope

Get the edit primitives right first:

- stable per-line anchors that survive nearby insertions/deletions
- exact anchor + line-content validation before mutation
- atomic batched edits across one file
- no harness-specific dependencies in `src/`
- adapters for MCP, Pi.dev, Claude Code, Codex CLI, and possibly useful pieces from tokenlean/cozempic

## Tool Preference

When MCP tools are available, Toolsmith is the default path for large-file code navigation and surgical edits.

- Files likely >200 lines: use `mcp__toolsmith__file_skeleton`, `mcp__toolsmith__get_function`, or bounded `mcp__toolsmith__anchored_read` before native Read/Write/Edit.
- Search before editing: use `mcp__toolsmith__find_and_anchor` or `mcp__toolsmith__anchored_search` instead of `rg` + `sed`/`cat`.
- Edit with validation: use `mcp__toolsmith__anchored_edit` / `mcp__toolsmith__anchored_edit_many`; use `mcp__toolsmith__symbol_replace` for one function/class/symbol.
- Native `Read`/`Edit`/`Write`, shell `cat`, `nl`, or broad `sed -n` are only fine for genuinely small files, command output, or when Toolsmith is unavailable.
- If you already used a native large-file read, switch to Toolsmith before editing so anchors and telemetry exist.

## Dev Flow

- `npm test` — unit tests
- `npm run check` — syntax check + tests
- `npm run test:harnesses` — reusable local harness checks
- `./scripts/test-harnesses.sh --skip-local --live-codex` — live Codex MCP check in a disposable workspace
- `./scripts/test-harnesses.sh --skip-local --live-claude` — live Claude MCP check in a disposable workspace
- `./scripts/test-harnesses.sh --skip-local --live-pi` — live Pi.dev strict Toolsmith check in a disposable workspace
- `toolsmith pi --print "..."` — run Pi with Toolsmith tools as the default strict edit harness
- `node bin/toolsmith.js scan-agent-logs --days 7` — inspect Claude/Codex adoption and large-file lost opportunities

Keep the core boring and dependency-light. Harness adapters should wrap this package rather than contaminating it. Update `docs/STATUS.md` when behavior, coverage, or caveats change.

## Hook Integration Judgment

Default to low-risk hooks that create feedback or nudge at the point of failure, not hooks that repeatedly inject prompt context.

- Good default: evidence/feedback hooks like the Codex Stop footer that report Toolsmith token savings only when explicitly opted in, without changing model instructions or doing synchronous work by default.
- Good optional path: targeted advisory hooks like the Claude PreToolUse tripwire for likely-large native reads/edits.
- Avoid by default: SessionStart/PostCompact-style context injection that strongly insists on Toolsmith every new/resumed/compacted session; it risks noise, duplication, and token cost.
- Durable priming belongs in `CLAUDE.md` / `AGENTS.md`; hooks should prove value or intervene only when behavior drifts.


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
