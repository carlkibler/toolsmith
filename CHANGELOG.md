# Changelog

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
