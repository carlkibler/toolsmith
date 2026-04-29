# Toolsmith Agent Guide

Portable core for hash-anchored, batched, low-token file edits across agent harnesses.

## Scope

Get the edit primitives right first:

- stable per-line anchors that survive nearby insertions/deletions
- exact anchor + line-content validation before mutation
- atomic batched edits across one file
- no harness-specific dependencies in `src/`
- adapters later for MCP, Pi.dev, Claude Code, Codex CLI, and possibly useful pieces from tokenlean/cozempic

## Dev Flow

- `npm test` — unit tests
- `npm run check` — syntax check + tests
- `npm run test:harnesses` — reusable local harness checks
- `./scripts/test-harnesses.sh --skip-local --live-codex` — live Codex MCP check in a disposable workspace
- `./scripts/test-harnesses.sh --skip-local --live-claude` — live Claude MCP check in a disposable workspace

Keep the core boring and dependency-light. Harness adapters should wrap this package rather than contaminating it. Update `docs/STATUS.md` when behavior, coverage, or caveats change.


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
