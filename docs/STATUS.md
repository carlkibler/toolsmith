# Project Status

Updated: 2026-05-07 (Pi.dev stale-package drift fix, global MCP cleanup)

## What exists now

`toolsmith` is a small Node package for portable, hash-anchored edit primitives inspired by Dirac's low-token editing flow.

Implemented pieces:

- Harness-independent core in `src/`
  - line hashing and opaque `Anchor§line` references
  - anchored reads with file hash headers
  - exact anchor + line-content validation before mutation
  - retry-friendly validation errors that show the exact full `Anchor§line` reference
  - compact anchored single-file search
  - repo/file search with `find_and_anchor` for anchored snippets across candidate files
  - compact structural reads with `file_skeleton` and `get_function`
  - safe symbol-scoped replacements with `symbol_replace`
  - lightweight telemetry for bytes/tokens avoided, request/response size, anchor count, and edit deltas
  - atomic single-file batched edits
  - atomic multi-file edit orchestration in filesystem wrapper
  - unchanged-line anchor preservation across nearby edits
- CLI in `bin/toolsmith.js`
  - `read`, `search`, `find-and-anchor`, `skeleton`, `get-function`, `symbol-replace`, `edit`, `edit-many`
  - `setup` / `install` — registers MCP with Claude Code, Codex, Gemini, Pi.dev, OpenCode, and detected JSON MCP clients; output is quiet for undetected clients and ordered Claude/Codex/Pi/OpenCode/Gemini first, then the rest alphabetically; safely installs a de-duplicated, quiet-by-default Codex Stop footer unless `--no-codex-footer` is passed; when explicitly enabled, the footer includes Codex token usage plus 5h/weekly limit reset countdowns when the transcript has rate-limit snapshots
  - `adopt` — standalone `--inject` / `--remove` for priming block without a full reinstall
  - `doctor` / `doc` — verifies Node ≥20, MCP binary, registration drift, Codex approval-policy, adoption gap, and log writability; `--fix` self-repairs most issues
  - `update` — installs the latest GitHub release package and refreshes MCP registrations/Codex footer by default (`--from PATH` opts into local checkout installs; `--no-setup` skips refresh; `--no-codex-footer` skips only the footer)
  - `scan-agent-logs`, `opportunities` (with token savings estimates), and `adoption-snippet` for adoption/lost-opportunity analysis
  - `audit` — shows estimated tokens saved by toolsmith AND estimated missed savings from native ops side-by-side
  - `tripwire` — optional native-use advisory hook for Claude Code; logs fires and prints Codex activation guidance
  - `mcp`
- MCP server in `bin/toolsmith-mcp.js`
  - `anchored_read`
  - `anchored_search`
  - `find_and_anchor`
  - `file_skeleton`
  - `get_function`
  - `symbol_replace`
  - `anchored_edit`
  - `anchored_edit_many`
  - `anchored_edit_status`
- Pi.dev adapter in `extensions/pi-toolsmith.js`
  - `pi_anchored_read`
  - `pi_anchored_search`
  - `pi_file_skeleton`
  - `pi_get_function`
  - `pi_symbol_replace`
  - `pi_anchored_edit`
  - `pi_anchored_edit_many`
  - `pi_anchored_status`
- Reusable harness scripts in `scripts/`
  - `install-harnesses.sh` registers Codex/Claude/Gemini MCP configs and installs the Pi package
  - `test-harnesses.sh` runs local checks and optional live Codex/Claude/Gemini/Pi validation
  - `toolsmith pi` runs Pi with Toolsmith tools as the strict default edit harness
  - Pi setup/doctor now treats stale `npm:@carlkibler/toolsmith` entries as drift when this checkout is the expected source; setup removes stale Pi package entries before reinstalling the current checkout/package path.

## Validation performed

Local automated checks:

- `npm run check` passes: 131 tests
- `npm pack --dry-run` succeeds and includes `bin/`, `docs/`, `extensions/`, `scripts/`, and `src/`
- `npm run test:harnesses -- --skip-local` succeeds

Integration coverage in tests:

- core anchor/read/edit/search/structure behavior
- atomic batch behavior and overlap rejection
- stale/inexact anchor rejection
- anchor preservation across insertion
- filesystem path containment
- CLI read smoke test
- MCP stdio integration through the inline test client (`doc --smoke` alias exercises the full handshake)
- directory search via `find_and_anchor` and subsequent anchored edit
- synthetic Claude/Codex session-log scanner coverage for adoption, lost opportunities, and interaction signals; including `lostLines` token savings tracking
- multi-file MCP edit validation
- Pi extension registration/execution with a fake ExtensionAPI
- Pi multi-file atomic failure behavior
- Pi setup/doctor/update integration and strict live harness execution
- Pi stale-package drift: `doctor` warns when Pi.dev points at `npm:@carlkibler/toolsmith` instead of this checkout, and `setup --force` removes the stale Pi package before reinstalling the current source
- multi-language skeleton and symbol detection: TypeScript, Python, Rust, Go
- partial read (startLine/endLine) correctness and token savings
- telemetry math: tokens avoided on partial reads, searches, and skeleton vs full file
- session store isolation: edits in one session do not affect another session's anchor tracking
- ReDoS protection: catastrophically backtracking regex patterns rejected via vm timeout check; fast-path pre-filter skips vm for no-quantifier patterns
- weekly audit postcard: `audit --week` emits week-over-week delta (agent calls, tokens avoided, missed savings, biggest lost op); `readUsageLog` `untilMs` filter for bounded windows
- Anchor Pact phase 1 (warn-mode): `AnchorStore` keyed by `(workspaceKey, sessionId, path)`; tool outputs prefixed with `[Workspace: …]`; `anchored_edit`/`anchored_edit_many` accept optional `workspace` field; mismatch warns instead of rejecting (phase 2 in 0.2.x)
- symlink TOCTOU mitigation: O_NOFOLLOW on all file opens, ELOOP fallback for workspace symlinks
- null byte rejection in path inputs
- write size enforcement at both schema validation and file write layers
- anchor-mismatch error human footer present; suppressed under TOOLSMITH_TERSE=1
- resilience: install-time MCP handshake smoke, crash guard recovery reporting, doctor self-repair
- setup: Codex config repair without orphan path tables; Codex approval-policy warning
- setup: priming block injection into CLAUDE.md (idempotent, round-trips cleanly with adopt --remove)
- doctor: adoption gap detection via usage log; suggestion to run `toolsmith adopt --inject`
- update: release-package install is the default; `--from PATH` is the explicit local-checkout escape hatch; integration refresh output hides undetected clients and JSON-client detection runs in parallel

Live harness checks performed:

- Codex MCP config installed and verified as `toolsmith`
- Claude MCP config installed and verified as `toolsmith`
- Codex live check successfully used `anchored_search` + `anchored_edit` in a disposable workspace to change `beta` to `BETA`
- Claude live check successfully used `mcp__toolsmith__anchored_search` + `mcp__toolsmith__anchored_edit` in a disposable workspace to change `beta` to `BETA`
- The live harness now also requires `file_skeleton` + `symbol_replace` before editing a small JavaScript function

Artifact logs from the latest validation runs are intentionally kept outside the repository.

## Fresh adoption scan — 2026-05-07

Representative local and remote development hosts were scanned after the adoption/priming changes. Toolsmith calls were present on both hosts, and the remaining gap was native-tool muscle memory under speed pressure rather than installation failure.

- Product implication shipped: Toolsmith now has an optional `tripwire` advisory path. `toolsmith tripwire install --client claude` wires a Claude PreToolUse hook for native Read/Edit/Write/MultiEdit/Bash on likely-large files, logs fires to `~/.local/state/toolsmith/tripwire.jsonl`, and `toolsmith audit` reports tripwire fire counts. Codex remains MCP-first, with `toolsmith tripwire snippet --client codex` for lazy `tool_search` activation guidance; setup/update also installs a conservative Codex Stop footer that stays silent by default and reports Toolsmith savings only when `TOOLSMITH_CODEX_FOOTER=1`, `TOOLSMITH_VERBOSE=1`, or `TOOLSMITH_DEBUG=1` is set.
- Follow-up bead: `toolsmith-rvf` tracks this tripwire work and can be closed after live multi-host installation plus a later rescan confirms reduced native misses.

## Local client expansion — 2026-05-07

- `toolsmith setup --force` now registers/refreshes OpenCode (`~/.config/opencode/opencode.json`), Cline CLI (`~/.cline/data/settings/cline_mcp_settings.json`), Cline's VS Code and Cursor extension settings, Cursor (`~/.cursor/mcp.json`), VS Code/Copilot (`~/Library/Application Support/Code/User/mcp.json`), Windsurf (`~/.codeium/windsurf/mcp_config.json`), Roo Code and Kilo Code extension settings, Continue (`~/.continue/mcpServers/toolsmith.json`), Zed (`~/.config/zed/settings.json`), Qwen Code (`~/.qwen/settings.json`), Kimi Code (`~/.kimi/mcp.json`), Crush (`~/.config/crush/crush.json`), Kilo CLI (`~/.config/kilo/kilo.json`), Void (`~/Library/Application Support/Void/User/mcp.json`), plus the earlier Claude/Codex/Gemini/Pi targets.
- `toolsmith doctor` now reports those JSON MCP clients and `doctor --fix --yes` can refresh drifted client configs across the expanded editor/CLI set.
- Local install verification: OpenCode 1.14.41 was already present; Cursor 3.3.22, Windsurf 2.2.17, and Zed 1.1.6 installed via Homebrew casks; Cline CLI 2.18.0, Qwen Code 0.15.8, Crush 0.66.0, Continue CLI 1.5.45, and Kilo CLI 7.2.40 installed via npm; Kimi Code 1.41.0 installed via `uv tool`; and Cline/Roo/Kilo/Continue extensions installed in VS Code and Cursor where available.
- Live effectiveness proof: OpenCode, Kilo CLI, Kimi Code, Crush, and Qwen Code all used Toolsmith `file_skeleton` against `lib/client-mcp.js` and returned `appUserPath`; Cline CLI also used `toolsmith/file_skeleton`. Cursor/VS Code/Windsurf/Zed/extension configs are installed, but editor agents do not all provide a reliable headless tool-use path.

## Known behavior / caveats

- Codex non-interactive normal approval mode can cancel mutating MCP calls before `anchored_edit` runs. The live Codex harness uses `--dangerously-bypass-approvals-and-sandbox` only inside a disposable workspace so the MCP behavior can be regression-tested without a human approval prompt.
- Tool schemas and validation errors now explain full `Anchor§line` and `endAnchor` requirements, but live model behavior should be rechecked after each harness update.
- Usage audits distinguish live-harness/test MCP calls from real agent/project calls; a passing live harness proves wiring, while non-test call counts show adoption during normal work.
- Session-log scanning is heuristic: Claude native large-file reads/edits and broad shell reads are hard lost opportunities; Codex `apply_patch` on large files is reported as a candidate, not automatically a mistake.
- Pi.dev has a real strict live-harness path through `toolsmith pi`; validate it after Pi/model/provider updates because it depends on live model behavior.

## Current commits (recent)

- `df48996` Add fast-path pre-filter to regex safety check (skip vm for no-quantifier patterns)
- `bb96450` Surface missed-savings estimate in audit command
- `1d0f80d` Sharpen MCP tool descriptions to drive adoption over native tools
- `62b7c02` Add token savings estimate to lost-opportunities output
- `af25fc6` Adoption pass: priming injection, adoption gap detection, kindness fixes
- `e7c2cf9` Harden toolsmith resilience: smoke install, crash guards, self-repair
- `819b96c` Release 0.1.12

## Language coverage

`fileSkeleton` and `getFunction`/`findSymbolStart` recognize declarations in:

| Language | Patterns |
|---|---|
| JavaScript | `function`, `async function`, `const/let/var = (` or `= x =>`, `class`, `import`, `export` |
| TypeScript | All JS patterns plus `interface`, `type`, `export default function` |
| Python | `def`, `async def`, `class` |
| Rust | `fn`, `async fn`, `pub fn`, `pub(crate) fn`, `struct`, `enum`, `trait`, `impl` (with optional `pub` prefix) |
| Go | `func`, `type ... struct` |
| Swift | `func`, `class`, `struct`, `enum`, `protocol`, `extension` |
| Ruby | `def`, `class`, `module` |

End-detection uses brace-counting for brace languages (JS/TS/Rust/Go/Swift/C-family) and indent-tracking for Python. Ruby `end` keyword is not special-cased — the indent tracker returns the last indented line before the `end`, which is close enough for symbol extraction.

## Next good steps

1. Install the Toolsmith tripwire on representative local and remote hosts, then rescan after real work to compare tripwire fires against native lost opportunities.
2. ~~Regex sandbox spike~~ — shipped: fast-path pre-filter skips vm for no-quantifier patterns; vm still guards quantifier patterns.
3. ~~Workspace-keyed anchors~~ — Anchor Pact phase 1 shipped: `AnchorStore` keys include `workspaceKey`; tool outputs prefixed with `[Workspace: …]`; `anchored_edit`/`anchored_edit_many` accept optional `workspace` field; mismatch warns in 0.1.x. Phase 2 (hard rejection) tracked separately.
4. ~~Weekly audit postcard~~ — shipped: `toolsmith audit --week` prints prev/this week delta plus biggest missed opportunity.
5. ~~Add a real Pi.dev live harness~~ — shipped via `scripts/test-harnesses.sh --live-pi` and `toolsmith pi`.
6. Decide which tokenlean/cozempic pieces belong here, keeping `src/` harness-neutral.
