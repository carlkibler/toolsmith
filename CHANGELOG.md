# Changelog

## Unreleased

- Silence the Claude tripwire for explicit small native reads (≤300 lines) even inside very large files; keep broad reads/edits protected, stop reporting threshold artifacts like `201 lines`, and align audit/session-scan heuristics with the quieter cutoff.

## 0.1.50 — 2026-06-09

- Soften the Claude tripwire for intentional prose/reference reads: Markdown/text specs now get a wider quiet lane, so near-threshold docs can be read whole without noisy PreToolUse nags.
- Keep the safety rail where it matters: edits to Markdown/spec files and large code reads still trip the normal large-file guidance.

## 0.1.49 — 2026-06-09

- Normalize persisted Node commands for MCP registrations and installed hooks: when setup runs under Homebrew's versioned `Cellar/node/.../bin/node`, Toolsmith now writes the stable `bin/node` shim instead of a path that disappears after `brew upgrade`/cleanup.
- Remove Toolsmith workspace containment: MCP tools now accept absolute paths, `..` traversal, and symlinked paths instead of rejecting them as "path escapes workspace." Anchored edits through symlinks update the resolved target without replacing the symlink. Toolsmith is a navigation/editing tool, not a filesystem sandbox.
- Update the tripwire catch-22 guard now that out-of-cwd paths are reachable; only files over Toolsmith's read-size limit stay nudge-only in fixed deny mode.

## 0.1.48 — 2026-06-02

`find_and_anchor` directory searches now rank smarter and respect a project ignore file (ideas borrowed from [Semble](https://github.com/MinishLab/semble), reimplemented zero-dependency):

- **BM25 relevance ranking.** Candidate files are scored by Okapi BM25 against the query (identifier-aware tokenization that splits `camelCase`/`snake_case`) and searched most-relevant-first. The match budget (`maxMatches`) now lands on the files that matter instead of whatever the directory walk hit first. Pure JS, no new dependencies.
- **`.toolsmithignore` support.** A gitignore-syntax file at the search root tunes what the walk visits — globs (`*`/`**`/`?`), leading-slash anchoring, trailing-slash dir-only patterns, and `!` force-include with last-match-wins precedence.

## 0.1.47 — 2026-05-29

The tripwire default is now **nudge-only**, and prompts are always haltable:

- **Default mode is `allow` (nudge), not `adaptive`.** The default never prompts or blocks — it just suggests Toolsmith at the moment of choice. `adaptive`/`ask`/`deny` are opt-in via `--tripwire-mode`. Rationale: a `PreToolUse` `ask`/`deny` overrides allow-rules and can't be dismissed per-project, so escalation-by-default reads as a broken, un-haltable tool on a real multi-file project. Nudge-only is the right first impression; the firmer push is there when you ask for it.
- **`bypassPermissions` downgrades every mode to a nudge.** If you've opted out of all prompts, the tripwire respects that instead of overriding it (the classic "hook still asks in bypass mode" trap). Applies even to a fixed `--mode deny`.

## 0.1.46 — 2026-05-29

- Fix: `toolsmith tripwire install --mode allow` and `setup --tripwire-mode allow` baked a hook command with **no** `--mode` flag, which then fell back to the runtime default (`adaptive`) — so asking for `allow` silently produced an *asking* hook. The mode is now always written explicitly. (Found in the field: an adaptive tripwire kept prompting in a project even after the operator tried to set it to nudge-only.)

## 0.1.45 — 2026-05-28

Make the adaptive tripwire safe to ship to any project — it was too eager to hard-block:

- **Adaptive now caps at `ask` and never auto-denies.** Hard blocking is opt-in via a fixed `--tripwire-mode deny`. A prompt is a strong nudge; an auto-block across thousands of projects is a hassle.
- **Using any Toolsmith tool resets the bypass count** (new `PostToolUse` hook on `mcp__toolsmith__*`). The counter now measures *consecutive ignoring* — native large-file ops with no Toolsmith use between them — not total large-file work. An agent that's actually using Toolsmith never escalates, however big the project. This was the real flaw: the old counter only went up, so even a mostly-compliant agent eventually tripped.
- Removed `TOOLSMITH_TRIPWIRE_DENY_AFTER` (adaptive no longer denies); `TOOLSMITH_TRIPWIRE_ASK_AFTER` still tunes the ask threshold. `toolsmith tripwire remove` cleans both the Pre and Post hooks.

## 0.1.44 — 2026-05-28

- Fix a tripwire catch-22: it no longer escalates to `ask`/`deny` for a file Toolsmith can't actually reach — one **outside the workspace** (its MCP tools refuse paths outside cwd) or **larger than its read limit**. Blocking those redirected the agent to a tool that would also refuse the file, with no valid way forward. Now they stay a nudge (`allow`) in every mode, including a fixed `--mode deny`. Found by dogfooding: a live agent hit `deny` editing `~/.claude/settings.json` from a project workspace.

## 0.1.43 — 2026-05-28

Adoption — the tripwire is now an active, self-correcting adoption engine:
- **Adaptive escalation (new default):** the tripwire counts how often an agent bypasses Toolsmith with a native large-file op in a session and gets firmer the longer it's ignored — nudge (allow) → ask → deny (defaults: ask after 3, deny after 6, tunable via `TOOLSMITH_TRIPWIRE_ASK_AFTER`/`_DENY_AFTER`). Compliant agents never feel it; a fresh session starts gentle. A fixed `--mode` opts out.
- **On by default:** `toolsmith setup` now installs the tripwire (was opt-in). `--no-tripwire` to skip, `--tripwire-mode` to fix the firmness.
- **Visceral nudges:** the nudge shows the real cost ("… is 1697 lines (~12K tokens to read whole) … a targeted read is a fraction of that").
- **Re-priming after compaction:** a SessionStart hook (installed with priming) re-asserts the "use mcp__toolsmith__* for large files" rule on startup/compact, so it doesn't fade as a long session's context is summarized.
- The "update available" notice now recommends the command matching how you installed: `brew upgrade carlkibler/tap/toolsmith` for Homebrew, `git pull` for checkouts, `toolsmith update` for npm.

Note: existing users who `toolsmith update` will get the tripwire installed (adaptive) on the re-run of setup. Disable with `toolsmith setup --no-tripwire` or `toolsmith tripwire remove`.

## 0.1.42 — 2026-05-28

Robustness:
- Preserve a file's line endings on edits. `anchored_edit`/`anchored_edit_many`/`symbol_replace` no longer silently rewrite a CRLF file to LF (which turned a 1-line change into a whole-file diff on Windows/CRLF repos). New `detectEol()` + EOL-aware rejoin.
- `anchored_edit_many` is now atomic across files: every file is staged to a temp before any rename, so a mid-batch write failure (disk full, permission flip) leaves zero files changed instead of a half-applied refactor.
- `looksBinary` scans the whole buffer for NUL (a NUL is valid UTF-8, so the old 8KB-prefix check could read NUL-bearing files as text).
- Tripwire fails OPEN on any error and resolves node via an absolute path with a PATH fallback (no nvm dependency). A tripwire bug or missing runtime can no longer block your Read/Edit/Bash by returning a non-zero PreToolUse exit.
- `setup` backs up each user config file (`<file>.toolsmith-bak`) before rewriting it — best-effort, never blocks the write; `mv` to restore.

Adoption:
- Tripwire escalation modes: `allow` (nudge, default) / `ask` (prompt) / `deny` (block native large-file ops and force a Toolsmith tool). Set via `toolsmith tripwire install --mode` or `TOOLSMITH_TRIPWIRE_MODE`. Sharper, action-forward nudges.
- Stronger preference-hint priming: an imperative MUST-rule with the token-cost rationale.
- "Update available" notifier on the CLI (stderr, interactive only), the MCP server (stderr), and the tripwire nudge. Cache-only on the hot path; at most one detached npm-registry check per day; install-kind and Homebrew aware. Never auto-applies. Opt out with `TOOLSMITH_NO_UPDATE_CHECK=1`.

Distribution:
- Homebrew tap (`brew install carlkibler/tap/toolsmith`), tested on macOS and Linux. Release pipeline auto-bumps the formula after npm publish (gated on `HOMEBREW_TAP_TOKEN`).
- README: Homebrew install, a "what setup changes on your machine" footprint table, a promoted Privacy section, an Uninstall section, and the audit→opportunities→tripwire→re-audit loop.

Transparency:
- `audit` splits the headline into defensible read-family savings (skeleton/get_function/anchored_read/_search/find_and_anchor, where a full-file counterfactual is realistic) vs. an "edit-family upper bound" (edits credit the whole pre-edit file). `trends` labels "tokens caught" as measured and "missed savings"/"interception rate" as modeled, with the assumed constants shown inline.
- Lost-savings projection names its constants and labels them as assumptions in the output, so the estimate can't read as a measurement.

## 0.1.41 — 2026-05-28

- Fix the Claude tripwire `PreToolUse` hook output failing newer Claude Code's strict JSON schema validation (`(root): Invalid input`). Drop the off-schema top-level `decision: "allow"` (that field only accepts `approve`/`block`); the decision lives in `hookSpecificOutput.permissionDecision`.
- Emit only documented `PreToolUse` fields: surface the nudge via top-level `systemMessage` and move it out of `hookSpecificOutput`, where `systemMessage` is undocumented and would break the same way if Claude Code tightens validation of that object.

## 0.1.40 — 2026-05-21

- Stamp provenance on every artifact Toolsmith installs into a user/project area (Codex footer script and hook command, Claude tripwire hook command, `CLAUDE.md`/`AGENTS.md` priming block, Codex `config.toml` MCP entry) via a shared `lib/provenance.js`, declaring Toolsmith ownership with links to the GitHub repo and npm package.
- Add a NON-NEGOTIABLE self-containment doctrine to `CLAUDE.md`: Toolsmith must provide, update, and manage any file it expects a harness to access, must never leave a dangling reference to a file it does not install, and must stamp provenance on every installed artifact.
- Move the dev-only validation hooks out of the misleading `templates/.claude/hooks/` path to `dev/claude-hooks/` (never auto-installed) so a global config can no longer reference a script nothing installs.

## 0.1.38 — 2026-05-19

- Treat legacy Claude `tl-hook run` tripwire commands as old Toolsmith hooks so tripwire install/update caretakes stale config and replaces them with the current Toolsmith hook.

## 0.1.35 — 2026-05-18

- Quiet default MCP and Pi.dev tool summaries by removing implementation-detail payload hints and hash transitions while keeping full anchored content in structured payloads.

## 0.1.34 — 2026-05-13

- Raise the installed Codex Stop footer hook timeout from 3s to 10s to avoid false timeout noise during intermittent transcript/disk stalls.
- Make the installed Codex Stop footer truly opt-in: default runs exit before reading stdin or starting Node, while `TOOLSMITH_CODEX_FOOTER=1`/verbose/debug still show bounded token-reduction and savings telemetry.

## 0.1.33 — 2026-05-12

- Migrate the Codex footer setup from deprecated `[features].codex_hooks` to `[features].hooks`.
- Ensure Toolsmith setup enables `hooks = true` when installing the Codex footer hook while preserving existing `hooks.json` entries.

## 0.1.32 — 2026-05-11

- Collapse Pi.dev setup/update drift repair into one concise output line per tool.
- Quiet expected stale-package removal failures when Toolsmith can prune the stale Pi.dev settings entry directly.

## 0.1.31 — 2026-05-11

- Harden `get_function`/`symbol_replace` symbol range detection for JavaScript and TypeScript functions with destructured parameters, including multiline destructuring before the body brace.
- Keep anchored tool responses quiet by default for MCP and Pi.dev adapters while preserving verbose anchored content opt-in.
- Strengthen anchored edit, workspace, adapter, and regex edge-case handling from multi-model hardening reviews.

## 0.1.26 — 2026-05-08

- Simplify install/update completion messaging to concise follow-up lines.
- Keep `toolsmith setup` and `toolsmith update` terminal completion output low-noise.

## 0.1.25 — 2026-05-08

- Make setup/update source labels describe the GitHub release package instead of leaking an internal install-kind label.
- Quiet Pi.dev refresh output so normal runs say simply `Pi.dev: refreshed`; path/source details now require `TOOLSMITH_VERBOSE` or `TOOLSMITH_DEBUG`.
- Reword stale global Node install doctor messages away from public npm package terminology.

## 0.1.24 — 2026-05-08

- Show Codex 5h/weekly rate-limit reset countdowns in the opt-in Codex footer when session transcripts include rate-limit snapshots.
- Scrub local host/provider-specific details from public status docs/tests and anonymize repository commit metadata.
- Keep the release script package-lock version in sync with package.json.

## 0.1.23 — 2026-05-07

- Make setup/update integration output quiet for undetected clients, print detected clients in priority order (Claude, Codex, Pi, OpenCode, Gemini) and alphabetize the rest.
- Probe JSON-based MCP client integrations in parallel before setup so broad install/update refreshes spend less time checking absent clients.

## 0.1.22 — 2026-05-07

- Make `toolsmith update` always install the latest GitHub release package by default, even when invoked from a local checkout, then refresh client integrations through the newly installed global binary. Use `--from PATH` to explicitly opt into installing from a local checkout.
- Prune stale Pi.dev package entries directly when `pi remove` cannot match an old relative checkout source.
- Keep JSON MCP client doctor tests hermetic under CI-provided `XDG_CONFIG_HOME`.

## 0.1.19 — 2026-05-06

- Fix `toolsmith doctor` so a linked global Node install that points at this checkout is reported as healthy instead of stale.
- Make Pi full-anchor guidance explicit in the extension prompt/schema, including copying the text after `§`.

## 0.1.18 — 2026-05-06

- Add Pi.dev as a first-class setup/update/doctor integration, including `toolsmith pi` strict harness launch and install-harness support.
- Strengthen Pi extension guidance with Dirac-inspired anchor lifecycle, batching, and inclusive end-anchor rules.

## 0.1.17 — 2026-05-06

- Fix the release-tag test assertion for detached-head `toolsmith update --check` output.

## 0.1.16 — 2026-05-06

- Keep `toolsmith update --check` informational on detached/tag checkouts so release verification does not fail just because GitHub Actions is testing a tag.
- Isolate setup/adopt tests from the repo checkout so `npm run check` no longer dirties `AGENTS.md`.

## 0.1.15 — 2026-05-06

- Strengthen Toolsmith-first guidance in repo instructions, setup priming, and adoption snippets so large-file reads/search/edit workflows default to anchored Toolsmith tools.
- Add the fresh multi-host adoption scan to `docs/STATUS.md`, including missed-savings evidence and the harness-backend direction.
- Keep npm installs clean by syncing `package-lock.json` with the package version.

## 0.1.12 — 2026-05-06

- Fix `toolsmith --version` (and `-v`) printing usage block and exiting 64 instead of printing the version.
- Fix `toolsmith update --global` silently skipping `npm install -g` when the tree was already up-to-date.
- Fix `toolsmith setup --global` missing devupgrade re-trap warning after global install.
- Fix `toolsmith doctor --fix` showing nothing when only non-fixable warnings (e.g. usage warnings) are present; now prints a clear "no registration issues to repair" message.

## 0.1.11 — 2026-05-05

- Add `installContext()` to detect whether toolsmith is running from a canonical git checkout, a global Node package install, or an unknown location.
- `toolsmith update` is now context-aware: git-checkout path skips `npm install -g .` by default (pass `--global` to opt in); add `--check` flag to report ahead/behind without modifying; refuse with a clear message for non-canonical checkouts.
- `toolsmith setup` shows the detected source and skips global Node install when running from a git checkout (pass `--global` to opt in).
- `toolsmith doctor` now detects stale MCP registrations (path no longer on disk) separately from drift (path differs from this checkout), using real-path equality for all clients including Claude Code (was substring match).
- `toolsmith doctor --fix` is now interactive: prompts per-client before re-registering. Add `--yes` to auto-confirm. Non-TTY sessions refuse without `--yes`. Removed the `npm install -g .` side-effect from `--fix` when running from a git checkout.
- `toolsmith doctor` warns when a stale global Node `@carlkibler/toolsmith` install coexists with a git-checkout install (the `devupgrade` trap).
- Add hidden `toolsmith --print-context --json` for debugging install context.

## 0.1.10 — 2026-05-05

- Deduplicate agent-log lost-opportunity examples so scan reports surface broader, more useful improvement targets.

## 0.1.9 — 2026-05-05

- Add `find_and_anchor` / `toolsmith find-and-anchor` for repo/file search that returns editable anchored snippets, including per-file result limits for broader directory coverage.
- Add `toolsmith scan-agent-logs`, `toolsmith opportunities`, and `toolsmith adoption-snippet` to analyze Claude/Codex session logs, adoption, lost opportunities, and prompt nudges.
- Include session-log opportunity summaries in `toolsmith audit` and extend doctor smoke coverage for the new MCP tool.
- Document stronger agent instructions for large-file search/edit workflows.

## 0.1.8 — 2026-05-05

- Clarify MCP registration refresh output so repeated update/setup runs say `refreshed` consistently across Claude, Codex, and Gemini.

## 0.1.7 — 2026-05-05

- Add `toolsmith doc` and `toolsmith install` aliases.
- Make `toolsmith update` refresh MCP registrations by default; `--no-setup` skips the refresh for unusual/manual cases.

## 0.1.6 — 2026-05-05

- Fix `toolsmith doctor --smoke` after the zero-dependency MCP rewrite; smoke checks now use a tiny inline JSON-RPC client instead of importing `@modelcontextprotocol/sdk`.
- Improve usage audits by splitting real agent calls from live-harness/test calls, including per-workspace summaries, tool-list events, and non-test efficiency totals.
- Record the package version in new MCP startup usage events instead of the old hard-coded telemetry version.

## 0.1.5 — 2026-05-03

- Drop all external dependencies (was 93 packages: `@modelcontextprotocol/sdk`, `zod`, `typebox`). MCP stdio server is now a minimal inline implementation — newline-delimited JSON-RPC 2.0, zero supply-chain surface.
- Suppress npm noise in `toolsmith update` — sub-commands run silently; stderr is shown only on failure.

## 0.1.4 — 2026-05-02

- `toolsmith update` now reports current version on start and prints `v0.1.3 → v0.1.4` after a successful upgrade, or `Already on v0.1.4 published 2026-05-02 — nothing to update.` when already current.

## 0.1.3 — 2026-05-02

- Include live-agent harness scripts in the published npm package.
- Let live-agent harness validation find usage events in the default Toolsmith usage log when clients do not pass custom MCP environment variables.

## 0.1.2 — 2026-05-02

- Expanded `toolsmith doctor` with provenance, canonical-repo, client config path, Pi.dev, MCP smoke-test, usage-health, and optional online freshness checks.
- Added `toolsmith doctor --fix` for registration repair and `toolsmith update --setup` for update-and-refresh workflows.
- Added efficiency totals and suggested `toolsmith audit` commands to `toolsmith doctor` usage output.
- Clarified zero-efficiency doctor output by reporting positive-savings calls, largest measured file, and why tiny test files can show no estimated savings.
- Expanded `toolsmith audit` with positive-savings counts, largest measured file, and tokens avoided by tool.
- Added `toolsmith charm`, a disposable large-file demo that proves positive token-savings telemetry.
- Added `toolsmith doctor --live-agent` and Pi live harness coverage for actual agent-tool-use verification.
- Added doctor hints for clients that start Toolsmith but do not call its tools.

## 0.1.0 — 2026-05-01

Initial release.

- Hash-anchored file reads with stable per-line opaque anchors (FNV1a-32)
- Exact anchor + line-content validation before any write
- Atomic batched edits for single and multiple files
- LCS-based anchor reconciliation surviving nearby insertions/deletions (greedy fallback for large files)
- Symbol-scoped replace (`symbol_replace`) for single-function edits
- File skeleton and `get_function` for structure-only reads
- Lightweight telemetry (bytes/tokens avoided, edit payload size)
- MCP server (`toolsmith-mcp`) with 8 registered tools
- Pi.dev extension
- CLI (`toolsmith`)
