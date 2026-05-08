#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACT_ROOT="${TOOLSMITH_ARTIFACT_DIR:-${DIRAC_EDIT_CORE_ARTIFACT_DIR:-$HOME/dev/agent-notes/toolsmith}}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$ARTIFACT_ROOT/harness-$STAMP"
RUN_LIVE_CODEX=0
RUN_LIVE_CLAUDE=0
RUN_LIVE_GEMINI=0
RUN_LIVE_PI=0

usage() {
  cat <<'USAGE'
Usage: scripts/test-harnesses.sh [--live] [--live-codex] [--live-claude] [--live-gemini] [--live-pi] [--skip-local]

Default checks are cheap and non-model:
  - npm run check
  - npm pack --dry-run
  - codex mcp get toolsmith
  - claude mcp get toolsmith
  - pi list (when Pi is installed)

Live checks use disposable temp workspaces and mutate only those temp files:
  --live         run Codex, Claude, Gemini, and Pi live edit checks
  --live-codex   run Codex live MCP edit check
  --live-claude  run Claude live MCP edit check
  --live-gemini  run Gemini live MCP edit check
  --live-pi      run Pi.dev live extension edit check
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
      RUN_LIVE_GEMINI=1
      RUN_LIVE_PI=1
      ;;
    --live-codex) RUN_LIVE_CODEX=1 ;;
    --live-claude) RUN_LIVE_CLAUDE=1 ;;
    --live-gemini) RUN_LIVE_GEMINI=1 ;;
    --live-pi) RUN_LIVE_PI=1 ;;
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

workspace_hash() {
  node -e 'import("./src/usage-log.js").then((m) => console.log(m.safeHash(process.argv[1])))' "$1"
}

assert_usage_tool_call() {
  local workspace="$1"
  local explicit_log="$2"
  local tool="$3"
  local ws_hash
  ws_hash="$(workspace_hash "$workspace")"

  local logs=("$explicit_log" "${XDG_STATE_HOME:-$HOME/.local/state}/toolsmith/usage.jsonl")
  local log
  for log in "${logs[@]}"; do
    if [[ -f "$log" ]] && grep -q "\"cwdHash\":\"$ws_hash\".*\"event\":\"tool_call\".*\"tool\":\"$tool\"" "$log"; then
      return 0
    fi
  done

  echo "No usage-log tool_call for $tool in workspace hash $ws_hash" >&2
  printf 'Checked logs:\n' >&2
  printf '  %s\n' "${logs[@]}" >&2
  exit 1
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

if command -v pi >/dev/null 2>&1; then
  log_step "pi package config"
  pi list 2>&1 | tee "$OUT/pi-list.log" || true
else
  echo "pi not found" | tee "$OUT/pi-list.log"
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
  CODEX_USAGE_LOG="$OUT/codex-usage.jsonl"
  TOOLSMITH_USAGE_LOG="$CODEX_USAGE_LOG" TOOLSMITH_USAGE_FULL_PATHS=1 codex exec --json --dangerously-bypass-approvals-and-sandbox -C "$CODEX_WS" --skip-git-repo-check "$CODEX_PROMPT" \
    2>&1 | tee "$OUT/codex-live.jsonl"
  assert_file_beta_changed "$CODEX_WS/sample.txt"
  grep -q 'return 2' "$CODEX_WS/code.js"
  grep -q '"server":"toolsmith","tool":"file_skeleton"' "$OUT/codex-live.jsonl"
  grep -q '"server":"toolsmith","tool":"symbol_replace"' "$OUT/codex-live.jsonl"
  grep -q '"server":"toolsmith","tool":"anchored_search"' "$OUT/codex-live.jsonl"
  grep -q '"server":"toolsmith","tool":"anchored_edit"' "$OUT/codex-live.jsonl"
  assert_usage_tool_call "$CODEX_WS" "$CODEX_USAGE_LOG" "anchored_edit"
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
  CLAUDE_USAGE_LOG="$OUT/claude-usage.jsonl"
  (
    cd "$CLAUDE_WS"
    printf '%s' "$CLAUDE_PROMPT" | TOOLSMITH_USAGE_LOG="$CLAUDE_USAGE_LOG" TOOLSMITH_USAGE_FULL_PATHS=1 claude -p --dangerously-skip-permissions --verbose --output-format stream-json --debug-file "$OUT/claude-debug.log"
  ) 2>&1 | tee "$OUT/claude-live.jsonl"
  assert_file_beta_changed "$CLAUDE_WS/sample.txt"
  grep -q 'return 2' "$CLAUDE_WS/code.js"
  grep -q '"name":"mcp__toolsmith__file_skeleton"' "$OUT/claude-live.jsonl"
  grep -q '"name":"mcp__toolsmith__symbol_replace"' "$OUT/claude-live.jsonl"
  grep -q '"name":"mcp__toolsmith__anchored_search"' "$OUT/claude-live.jsonl"
  grep -q '"name":"mcp__toolsmith__anchored_edit"' "$OUT/claude-live.jsonl"
  assert_usage_tool_call "$CLAUDE_WS" "$CLAUDE_USAGE_LOG" "anchored_edit"
fi

if [[ "$RUN_LIVE_GEMINI" -eq 1 ]]; then
  if ! command -v gemini >/dev/null 2>&1; then
    echo "gemini not found; cannot run --live-gemini" >&2
    exit 1
  fi
  log_step "gemini live MCP edit"
  GEMINI_WS="$(seed_workspace gemini)"
  GEMINI_PROMPT=$(cat <<'EOF'
Use the toolsmith MCP server. First use file_skeleton on code.js, then use symbol_replace to change 'return 1' to 'return 2' inside the demo symbol. Then use anchored_search and anchored_edit to change sample.txt line beta to BETA. Do not use shell commands or built-in file editing tools for mutation. Report final contents.
EOF
)
  GEMINI_USAGE_LOG="$OUT/gemini-usage.jsonl"
  (
    cd "$GEMINI_WS"
    TOOLSMITH_USAGE_LOG="$GEMINI_USAGE_LOG" TOOLSMITH_USAGE_FULL_PATHS=1 gemini --skip-trust --yolo --allowed-mcp-server-names toolsmith --output-format stream-json -p "$GEMINI_PROMPT"
  ) 2>&1 | tee "$OUT/gemini-live.jsonl"
  assert_file_beta_changed "$GEMINI_WS/sample.txt"
  grep -q 'return 2' "$GEMINI_WS/code.js"
  grep -q '"tool_name":"mcp_toolsmith_file_skeleton"' "$OUT/gemini-live.jsonl"
  grep -q '"tool_name":"mcp_toolsmith_symbol_replace"' "$OUT/gemini-live.jsonl"
  grep -q '"tool_name":"mcp_toolsmith_anchored_search"' "$OUT/gemini-live.jsonl"
  grep -q '"tool_name":"mcp_toolsmith_anchored_edit"' "$OUT/gemini-live.jsonl"
  assert_usage_tool_call "$GEMINI_WS" "$GEMINI_USAGE_LOG" "anchored_edit"
fi

if [[ "$RUN_LIVE_PI" -eq 1 ]]; then
  if ! command -v pi >/dev/null 2>&1; then
    echo "pi not found; cannot run --live-pi" >&2
    exit 1
  fi
  log_step "pi live extension edit"
  PI_WS="$(seed_workspace pi)"
  PI_PROMPT=$(cat <<'EOF'
Use the installed toolsmith Pi tools. First use pi_file_skeleton on code.js, then pi_symbol_replace to change 'return 1' to 'return 2' inside demo. Then use pi_anchored_search and pi_anchored_edit to change sample.txt line beta to BETA. Report final contents.
EOF
)
  (
    cd "$PI_WS"
    node "$ROOT/bin/toolsmith.js" pi \
      --no-context-files --no-skills --no-prompt-templates --no-themes \
      --mode json --print "$PI_PROMPT"
  ) 2>&1 | tee "$OUT/pi-live.jsonl"
  assert_file_beta_changed "$PI_WS/sample.txt"
  grep -q 'return 2' "$PI_WS/code.js"
  grep -q '"toolName":"pi_file_skeleton"' "$OUT/pi-live.jsonl"
  grep -q '"toolName":"pi_symbol_replace"' "$OUT/pi-live.jsonl"
  grep -q '"toolName":"pi_anchored_search"' "$OUT/pi-live.jsonl"
  grep -q '"toolName":"pi_anchored_edit"' "$OUT/pi-live.jsonl"
fi

log_step "done"
echo "Artifacts: $OUT"
