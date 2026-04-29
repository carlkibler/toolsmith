# Project Status

Updated: 2026-04-29

## What exists now

`dirac-edit-core` is a small Node package for portable, hash-anchored edit primitives inspired by Dirac's low-token editing flow.

Implemented pieces:

- Harness-independent core in `src/`
  - line hashing and opaque `Anchor§line` references
  - anchored reads with file hash headers
  - exact anchor + line-content validation before mutation
  - retry-friendly validation errors that show the exact full `Anchor§line` reference
  - compact anchored single-file search
  - compact structural reads with `file_skeleton` and `get_function`
  - safe symbol-scoped replacements with `symbol_replace`
  - lightweight telemetry for bytes/tokens avoided, request/response size, anchor count, and edit deltas
  - atomic single-file batched edits
  - atomic multi-file edit orchestration in filesystem wrapper
  - unchanged-line anchor preservation across nearby edits
- CLI in `bin/dirac-edit-core.mjs`
  - `read`
  - `edit`
  - `mcp`
- MCP server in `bin/dirac-edit-core-mcp.mjs`
  - `anchored_read`
  - `anchored_search`
  - `file_skeleton`
  - `get_function`
  - `symbol_replace`
  - `anchored_edit`
  - `anchored_edit_many`
  - `anchored_edit_status`
- Pi.dev adapter in `extensions/pi-dirac-edit-core.js`
  - `pi_anchored_read`
  - `pi_anchored_search`
  - `pi_file_skeleton`
  - `pi_get_function`
  - `pi_symbol_replace`
  - `pi_anchored_edit`
  - `pi_anchored_edit_many`
  - `pi_anchored_status`
- Reusable harness scripts in `scripts/`
  - `install-harnesses.sh` registers Codex + Claude MCP configs
  - `test-harnesses.sh` runs local checks and optional live Codex/Claude validation

## Validation performed

Local automated checks:

- `npm run check` passes: 24 tests
- `npm pack --dry-run` succeeds and includes `bin/`, `docs/`, `extensions/`, `scripts/`, and `src/`
- `npm run test:harnesses -- --skip-local` succeeds

Integration coverage in tests:

- core anchor/read/edit/search/structure behavior
- atomic batch behavior and overlap rejection
- stale/inexact anchor rejection
- anchor preservation across insertion
- filesystem path containment
- CLI read smoke test
- MCP stdio integration through the official SDK client transport
- multi-file MCP edit validation
- Pi extension registration/execution with a fake ExtensionAPI
- Pi multi-file atomic failure behavior

Live harness checks performed:

- Codex MCP config installed and verified as `dirac-edit-core`
- Claude MCP config installed and verified as `dirac-edit-core`
- Codex live check successfully used `anchored_search` + `anchored_edit` in a disposable workspace to change `beta` to `BETA`
- Claude live check successfully used `mcp__dirac-edit-core__anchored_search` + `mcp__dirac-edit-core__anchored_edit` in a disposable workspace to change `beta` to `BETA`
- The live harness now also requires `file_skeleton` + `symbol_replace` before editing a small JavaScript function

Artifact logs from the latest validation runs live under `~/dev/agent-notes/dirac-edit-core/harness-*`.

## Known behavior / caveats

- Codex non-interactive normal approval mode can cancel mutating MCP calls before `anchored_edit` runs. The live Codex harness uses `--dangerously-bypass-approvals-and-sandbox` only inside a disposable workspace so the MCP behavior can be regression-tested without a human approval prompt.
- Tool schemas and validation errors now explain full `Anchor§line` and `endAnchor` requirements, but live model behavior should be rechecked after each harness update.
- Pi.dev has an adapter-level fake-API test, but a real Pi installation/live model run has not been validated yet.

## Current commits

- `e975fc0` Initial dirac edit core scaffold
- `2ffab45` Add MCP CLI and Pi adapters
- `e6fc3d6` Add multi-file anchored edit validation
- `2dcd129` Add reusable harness validation scripts
- `af3096c` Add project status notes
- `0c47cd3` Add anchored search and clearer edit guidance
- `c66dc00` Add structural read tools
- `071ee5e` Add symbol-scoped replace tool

## Next good steps

1. Add a CLI/report mode to compare old-vs-new tool-call payloads on larger real files.
2. Add a real Pi.dev live harness once the installed Pi CLI/tool-extension invocation is confirmed.
3. Compare `symbol_replace` vs anchored edit behavior on larger real files.
4. Decide which tokenlean/cozempic pieces belong here, keeping `src/` harness-neutral.
5. Explore convenience wrappers for Claude/Codex that preserve safety while avoiding noisy interactive MCP approval failure in background regression runs.
