# Project Status

Updated: 2026-04-29

## What exists now

`dirac-edit-core` is a small Node package for portable, hash-anchored edit primitives inspired by Dirac's low-token editing flow.

Implemented pieces:

- Harness-independent core in `src/`
  - line hashing and opaque `Anchor§line` references
  - anchored reads with file hash headers
  - exact anchor + line-content validation before mutation
  - atomic single-file batched edits
  - atomic multi-file edit orchestration in filesystem wrapper
  - unchanged-line anchor preservation across nearby edits
- CLI in `bin/dirac-edit-core.mjs`
  - `read`
  - `edit`
  - `mcp`
- MCP server in `bin/dirac-edit-core-mcp.mjs`
  - `anchored_read`
  - `anchored_edit`
  - `anchored_edit_many`
  - `anchored_edit_status`
- Pi.dev adapter in `extensions/pi-dirac-edit-core.js`
  - `pi_anchored_read`
  - `pi_anchored_edit`
  - `pi_anchored_edit_many`
  - `pi_anchored_status`
- Reusable harness scripts in `scripts/`
  - `install-harnesses.sh` registers Codex + Claude MCP configs
  - `test-harnesses.sh` runs local checks and optional live Codex/Claude validation

## Validation performed

Local automated checks:

- `npm run check` passes: 16 tests
- `npm pack --dry-run` succeeds and includes `bin/`, `docs/`, `extensions/`, `scripts/`, and `src/`
- `npm run test:harnesses -- --skip-local` succeeds

Integration coverage in tests:

- core anchor/read/edit behavior
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
- Codex live check successfully used `anchored_read` + `anchored_edit` in a disposable workspace to change `beta` to `BETA`
- Claude live check successfully used `mcp__dirac-edit-core__anchored_read` + `mcp__dirac-edit-core__anchored_edit` in a disposable workspace to change `beta` to `BETA`

Artifact logs from the latest validation runs live under `~/dev/agent-notes/dirac-edit-core/harness-*`.

## Known behavior / caveats

- Codex non-interactive normal approval mode can cancel mutating MCP calls before `anchored_edit` runs. The live Codex harness uses `--dangerously-bypass-approvals-and-sandbox` only inside a disposable workspace so the MCP behavior can be regression-tested without a human approval prompt.
- Models need explicit prompting today to include the full `Anchor§line` reference and `endAnchor` for single-line replaces. A future adapter or prompt wrapper should make this harder to misuse.
- Pi.dev has an adapter-level fake-API test, but a real Pi installation/live model run has not been validated yet.

## Current commits

- `e975fc0` Initial dirac edit core scaffold
- `2ffab45` Add MCP CLI and Pi adapters
- `e6fc3d6` Add multi-file anchored edit validation
- `2dcd129` Add reusable harness validation scripts

## Next good steps

1. Improve tool schemas/descriptions so Codex and Claude naturally supply exact anchors and `endAnchor` with less prompt coaching.
2. Add a real Pi.dev live harness once the installed Pi CLI/tool-extension invocation is confirmed.
3. Add token-saving telemetry: bytes/tokens avoided, anchor map size, edit payload size, and old-vs-new tool-call comparison.
4. Decide which tokenlean/cozempic pieces belong here, keeping `src/` harness-neutral.
5. Explore convenience wrappers for Claude/Codex that preserve safety while avoiding noisy interactive MCP approval failure in background regression runs.
