#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACT_ROOT="${TOOLSMITH_ARTIFACT_DIR:-${DIRAC_EDIT_CORE_ARTIFACT_DIR:-$HOME/dev/agent-notes/toolsmith}}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$ARTIFACT_ROOT/harness-$STAMP"
RUN_LIVE_CODEX=0
RUN_LIVE_CLAUDE=0

usage() {
  cat <<'USAGE'
Usage: scripts/test-harnesses.sh [--live] [--live-codex] [--live-claude] [--skip-local]

Default checks are cheap and non-model:
  - npm run check
  - npm pack --dry-run
  - codex mcp get toolsmith
  - claude mcp get toolsmith

Live checks use disposable temp workspaces and mutate only those temp files:
  --live         run both Codex and Claude live MCP edit checks
  --live-codex   run Codex live MCP edit check
  --live-claude  run Claude live MCP edit check
  --skip-local   skip npm/check/package checks

Artifacts are written to ~/dev/agent-notes/toolsmith/harness-<timestamp>/.
USAGE
}

RUN_LOCAL=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --live)
      RUN_LIVE_CODEX=1
      RUN_LIVE_CLAUDE=1
      ;;
    --live-codex) RUN_LIVE_CODEX=1 ;;
    --live-claude) RUN_LIVE_CLAUDE=1 ;;
    --skip-local) RUN_LOCAL=0 ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 64
      ;;
  esac
  shift
done

mkdir -p "$OUT"
cd "$ROOT"

log_step() {
  printf '\n==> %s\n' "$*"
}

seed_workspace() {
  local name="$1"
  local dir="$OUT/$name-workspace"
  mkdir -p "$dir"
  cat > "$dir/sample.txt" <<'EOF'
alpha
beta
gamma
EOF
  cat > "$dir/other.txt" <<'EOF'
one
two
three
EOF
  cat > "$dir/code.js" <<'EOF'
function demo() {
  return 1
}
EOF
  printf '%s\n' "$dir"
}

assert_file_beta_changed() {
  local file="$1"
  local actual
  actual="$(cat "$file")"
  local expected=$'alpha\nBETA\ngamma'
  if [[ "$actual" != "$expected" ]]; then
    echo "Unexpected file content in $file" >&2
    printf 'Expected:\n%s\nActual:\n%s\n' "$expected" "$actual" >&2
    exit 1
  fi
}

if [[ "$RUN_LOCAL" -eq 1 ]]; then
  log_step "local package checks"
  npm run check 2>&1 | tee "$OUT/npm-check.log"
  npm pack --dry-run 2>&1 | tee "$OUT/npm-pack-dry-run.log"
fi

if command -v codex >/dev/null 2>&1; then
  log_step "codex MCP config"
  codex mcp get toolsmith 2>&1 | tee "$OUT/codex-mcp-get.log" || true
else
  echo "codex not found" | tee "$OUT/codex-mcp-get.log"
fi

if command -v claude >/dev/null 2>&1; then
  log_step "claude MCP config"
  claude mcp get toolsmith 2>&1 | tee "$OUT/claude-mcp-get.log" || true
else
  echo "claude not found" | tee "$OUT/claude-mcp-get.log"
fi

if [[ "$RUN_LIVE_CODEX" -eq 1 ]]; then
  if ! command -v codex >/dev/null 2>&1; then
    echo "codex not found; cannot run --live-codex" >&2
    exit 1
  fi
  log_step "codex live MCP edit"
  CODEX_WS="$(seed_workspace codex)"
  CODEX_PROMPT=$(cat <<'EOF'
Use the toolsmith MCP server. First use file_skeleton on code.js, then use symbol_replace to change 'return 1' to 'return 2' inside the demo symbol. Then use anchored_search and anchored_edit to change sample.txt line beta to BETA. Do not use shell commands, anchored_read, or built-in file editing tools for mutation. Report final contents.
EOF
)
  codex exec --json --dangerously-bypass-approvals-and-sandbox -C "$CODEX_WS" --skip-git-repo-check "$CODEX_PROMPT" \
    2>&1 | tee "$OUT/codex-live.jsonl"
  assert_file_beta_changed "$CODEX_WS/sample.txt"
  grep -q 'return 2' "$CODEX_WS/code.js"
  grep -q '"server":"toolsmith","tool":"file_skeleton"' "$OUT/codex-live.jsonl"
  grep -q '"server":"toolsmith","tool":"symbol_replace"' "$OUT/codex-live.jsonl"
  grep -q '"server":"toolsmith","tool":"anchored_search"' "$OUT/codex-live.jsonl"
  grep -q '"server":"toolsmith","tool":"anchored_edit"' "$OUT/codex-live.jsonl"
fi

if [[ "$RUN_LIVE_CLAUDE" -eq 1 ]]; then
  if ! command -v claude >/dev/null 2>&1; then
    echo "claude not found; cannot run --live-claude" >&2
    exit 1
  fi
  log_step "claude live MCP edit"
  CLAUDE_WS="$(seed_workspace claude)"
  CLAUDE_PROMPT=$(cat <<'EOF'
Use the toolsmith MCP server. First use file_skeleton on code.js, then use symbol_replace to change 'return 1' to 'return 2' inside the demo symbol. Then use anchored_search and anchored_edit to change sample.txt line beta to BETA. Do not use Bash, anchored_read, or built-in Edit/Write for mutation. Report final contents.
EOF
)
  (
    cd "$CLAUDE_WS"
    printf '%s' "$CLAUDE_PROMPT" | claude -p --dangerously-skip-permissions --verbose --output-format stream-json --debug-file "$OUT/claude-debug.log"
  ) 2>&1 | tee "$OUT/claude-live.jsonl"
  assert_file_beta_changed "$CLAUDE_WS/sample.txt"
  grep -q 'return 2' "$CLAUDE_WS/code.js"
  grep -q '"name":"mcp__toolsmith__file_skeleton"' "$OUT/claude-live.jsonl"
  grep -q '"name":"mcp__toolsmith__symbol_replace"' "$OUT/claude-live.jsonl"
  grep -q '"name":"mcp__toolsmith__anchored_search"' "$OUT/claude-live.jsonl"
  grep -q '"name":"mcp__toolsmith__anchored_edit"' "$OUT/claude-live.jsonl"
fi

log_step "done"
echo "Artifacts: $OUT"

