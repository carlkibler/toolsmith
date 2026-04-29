# Porting Plan

## Phase 1: Core

Build and test harness-independent primitives:

1. `AnchorStore` tracks line hashes and opaque anchors by session + path.
2. `readAnchored` returns `[File Hash: ...]` plus `Anchor§line` output.
3. `applyAnchoredEdits` validates anchor existence and exact line content before applying edits.
4. Edits are atomic by default: any invalid/overlapping edit aborts the batch.

## Phase 2: MCP Adapter

Implemented as `bin/toolsmith-mcp.mjs`. Expose tools that Claude Code and Codex CLI can add as an MCP server:

- `anchored_read`
- `anchored_edit`
- `anchored_search` - implemented for single-file compact anchored snippets
- `file_skeleton` - implemented with lightweight declaration heuristics
- `get_function` - implemented with lightweight name/range heuristics
- `symbol_replace` - implemented as a safe symbol-scoped literal/regex replacement helper

## Phase 3: Pi.dev Adapter

Implemented initially as `extensions/pi-toolsmith.js`. A Pi package can feel more native than MCP:

- override/add read and edit tools
- route multi-file edit batches through this core
- expose compact anchored search and savings telemetry if useful

## Later Imports

- tokenlean: token accounting, compact command/search outputs, capture/savings reporting.
- cozempic: only if it has generally useful Codex/harness compatibility pieces; avoid dragging product-specific code into the core.


## Test Coverage Now

- Core anchor/read/edit unit tests.
- Filesystem wrapper tests with temp workspaces.
- CLI smoke test.
- MCP stdio integration test using the official MCP SDK client transport, including multi-file edits.
- Pi extension registration/execution test with a fake ExtensionAPI and temp workspace, including atomic multi-file failure behavior.

Remaining manual-ish validation later: install the package into real Pi/Codex/Claude configs and watch a model choose the tools naturally. That requires either user-visible config changes or live model calls, so it is intentionally not part of the default automated suite yet.
