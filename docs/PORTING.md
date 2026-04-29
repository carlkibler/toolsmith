# Porting Plan

## Phase 1: Core

Build and test harness-independent primitives:

1. `AnchorStore` tracks line hashes and opaque anchors by session + path.
2. `readAnchored` returns `[File Hash: ...]` plus `Anchor§line` output.
3. `applyAnchoredEdits` validates anchor existence and exact line content before applying edits.
4. Edits are atomic by default: any invalid/overlapping edit aborts the batch.

## Phase 2: MCP Adapter

Expose tools that Claude Code and Codex CLI can add as an MCP server:

- `anchored_read`
- `anchored_edit`
- `anchored_search`
- later: `symbol_replace`, `file_skeleton`, `get_function`

## Phase 3: Pi.dev Adapter

A Pi package can feel more native than MCP:

- override/add read and edit tools
- route multi-file edit batches through this core
- expose savings telemetry if useful

## Later Imports

- tokenlean: token accounting, compact command/search outputs, capture/savings reporting.
- cozempic: only if it has generally useful Codex/harness compatibility pieces; avoid dragging product-specific code into the core.
