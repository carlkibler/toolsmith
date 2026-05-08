#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER="$ROOT/bin/toolsmith-mcp.js"

if [[ ! -f "$SERVER" ]]; then
  echo "Missing MCP server: $SERVER" >&2
  exit 1
fi

if command -v codex >/dev/null 2>&1; then
  if codex mcp get dirac-edit-core >/dev/null 2>&1; then
    codex mcp remove dirac-edit-core >/dev/null 2>&1 || true
  fi
  if codex mcp get toolsmith >/dev/null 2>&1; then
    codex mcp remove toolsmith >/dev/null 2>&1 || true
  fi
  codex mcp add toolsmith -- node "$SERVER"
  codex mcp get toolsmith
else
  echo "codex not found; skipping Codex install" >&2
fi

if command -v claude >/dev/null 2>&1; then
  if claude mcp get dirac-edit-core >/dev/null 2>&1; then
    claude mcp remove dirac-edit-core -s user >/dev/null 2>&1 || true
  fi
  if claude mcp get toolsmith >/dev/null 2>&1; then
    claude mcp remove toolsmith -s user >/dev/null 2>&1 || true
  fi
  claude mcp add -s user toolsmith -- node "$SERVER"
  claude mcp get toolsmith
else
  echo "claude not found; skipping Claude install" >&2
fi


if command -v gemini >/dev/null 2>&1; then
  gemini mcp remove toolsmith >/dev/null 2>&1 || true
  gemini mcp add --scope user --trust toolsmith node "$SERVER" >/dev/null 2>&1 || true
  gemini mcp list || true
else
  echo "gemini not found; skipping Gemini install" >&2
fi

if command -v pi >/dev/null 2>&1; then
  pi install "$ROOT"
  pi list | grep -A1 -E '(^|/)toolsmith($|[[:space:]])' || pi list
else
  echo "pi not found; skipping Pi.dev install" >&2
fi
