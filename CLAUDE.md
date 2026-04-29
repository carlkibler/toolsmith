# Dirac Edit Core Agent Guide

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

Keep the core boring and dependency-light. Harness adapters should wrap this package rather than contaminating it.
