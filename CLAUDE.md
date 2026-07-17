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

- Files likely >200 lines: use `mcp__toolsmith__file_skeleton`, `mcp__toolsmith__get_function`, or `mcp__toolsmith__anchored_read` for broad reads and edits; native `Read` with an explicit small range/limit up to ~300 lines is fine for inspection.
- Search before editing: use `mcp__toolsmith__find_and_anchor` or `mcp__toolsmith__anchored_search` instead of `rg` + `sed`/`cat`.
- Edit with validation: use `mcp__toolsmith__anchored_edit` / `mcp__toolsmith__anchored_edit_many`; use `mcp__toolsmith__symbol_replace` for one function/class/symbol.
- Native `Read` with a small bounded range, command output, and genuinely small files are fine. Avoid native `Edit`/`Write`, shell `cat`/`nl`, and broad `sed -n` on large files when Toolsmith is available.
- If you already used a native bounded read and need to edit that area, switch to Toolsmith before changing it so anchors and telemetry exist.

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

## Self-Containment Doctrine (NON-NEGOTIABLE)

**Toolsmith must be fully self-contained. It owns every file it expects a harness to touch — providing, updating, and maintaining that file across every machine and harness it supports. Toolsmith must NEVER cause a user-facing error because it forgot to ship its own file.**

Concretely, for any agent working on Toolsmith:

- **If Toolsmith causes a harness to reference a file** (a hook script, a config snippet, a binary path), Toolsmith's `setup`/`update` path MUST install that file and keep it current. No exceptions, no "it'll get copied somehow."
- **No dangling references.** Never wire a `settings.json` / `hooks.json` / `config.toml` entry that points at a path Toolsmith does not itself create and verify on that machine. A reference whose target may not exist is a bug, even if it "works on my machine".
- **No install-by-manual-copy.** If a file only reaches a machine because someone `scp`'d it once, it is not installed. Provisioning must be reproducible from `toolsmith setup`/`update` alone.
- **Do not scatter files into shared/global harness locations you don't manage** (e.g. global `~/.claude/hooks/`). Either install + own them end-to-end, or keep them inside the Toolsmith repo/package.
- **Stamp provenance on every installed artifact.** Anything Toolsmith writes into a user/project area must declare it belongs to Toolsmith and link to the repo + npm package, using `lib/provenance.js`. Shell scripts get the `#` header (`shellProvenanceHeader`); injected shell-command hooks, TOML entries, and Markdown priming blocks get the inline `provenanceTag()`. Pure-JSON entries (MCP server objects in `settings.json`) can't hold comments — there the `toolsmith` server key is the identifier. A user must always be able to look at an installed file and find out what put it there.
- **Dev-only artifacts stay clearly dev-only.** Helper hooks for developing Toolsmith live in `dev/claude-hooks/` (not published, not auto-installed) — see that README. Never give them a name or path that implies "install me" (the old `templates/.claude/hooks/` path did, and it errored on every machine that never got the manual copy).
- **Verify on every supported target.** A fix isn't done until you've confirmed the file exists and runs on each machine/harness Toolsmith claims to support, not just the one you're typing on.

The test: *"If a fresh machine runs only `toolsmith setup`, will every file Toolsmith references exist and work?"* If the answer is "no" or "only after a manual step", the change is incomplete.


## Session Completion

**When ending a work session**, complete these steps. Work is NOT done until `git push` succeeds.

1. **Note remaining work** — record anything that needs follow-up for the next session
2. **Run quality gates** (if code changed) — tests, linters, builds
3. **Push to remote** — this is mandatory:
   ```bash
   git pull --rebase
   git push
   git status  # MUST show "up to date with origin"
   ```
4. **Clean up** — clear stashes, prune remote branches
5. **Verify** — all changes committed AND pushed
6. **Hand off** — provide context for the next session

**Never** stop before pushing — that strands work locally. If push fails, resolve and retry until it succeeds.
