# Changelog

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
