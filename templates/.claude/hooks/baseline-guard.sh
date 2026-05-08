#!/usr/bin/env bash
#
# SessionStart hook (and standalone): Baseline Guard
#
# When an in-progress bead exists and a test command is detectable:
#   1. Runs the test suite with a 60s timeout
#   2. Stores "BASELINE: N pass, N fail" in bead notes
#   3. Outputs a system message so the agent knows the baseline
#
# Call standalone: baseline-guard.sh [project_dir]
# Call as hook: receives JSON on stdin (SessionStart format)

set -uo pipefail

command -v bd &>/dev/null || exit 0

PROJECT_DIR="${1:-.}"
cd "$PROJECT_DIR" 2>/dev/null || true

BEAD_ID=$(bd list --status=in_progress --json 2>/dev/null \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['id'] if d else '')" 2>/dev/null)
[[ -z "$BEAD_ID" ]] && exit 0

# Detect test command
TEST_CMD=""
if [[ -f "package.json" ]] && python3 -c "import json; d=json.load(open('package.json')); exit(0 if d.get('scripts',{}).get('test') else 1)" 2>/dev/null; then
    TEST_CMD="npm test --silent 2>&1"
elif [[ -f "Makefile" ]] && grep -q "^test:" Makefile 2>/dev/null; then
    TEST_CMD="make test 2>&1"
elif [[ -f "pyproject.toml" ]] || [[ -f "setup.py" ]]; then
    if command -v uv &>/dev/null; then
        TEST_CMD="uv run python -m pytest -q 2>&1"
    else
        TEST_CMD="python -m pytest -q 2>&1"
    fi
elif [[ -f "Cargo.toml" ]]; then
    TEST_CMD="cargo test --quiet 2>&1"
elif [[ -f "go.mod" ]]; then
    TEST_CMD="go test ./... 2>&1"
fi

[[ -z "$TEST_CMD" ]] && exit 0

# Run with timeout, capture output
RAW=$(timeout 60 bash -c "$TEST_CMD" 2>&1 | tail -20) || EXITCODE=$?
EXITCODE=${EXITCODE:-0}

# Summarise result in one line
if [[ $EXITCODE -eq 0 ]]; then
    STATUS="pass"
    # Try to extract count from common formats
    COUNT=$(echo "$RAW" | grep -oE '[0-9]+ (passed|tests? passed|ok)' | head -1)
    SUMMARY="${COUNT:-tests pass}"
else
    STATUS="fail"
    COUNT=$(echo "$RAW" | grep -oE '[0-9]+ (failed|error)' | head -1)
    SUMMARY="${COUNT:-some failures} — see bead notes"
fi

BASELINE_NOTE="BASELINE [$(date +%H:%M)]: ${STATUS} — ${SUMMARY}"

# Store in bead notes (non-blocking)
bd update "$BEAD_ID" --notes "$BASELINE_NOTE" 2>/dev/null || true

python3 - "$BEAD_ID" "$STATUS" "$BASELINE_NOTE" "$RAW" << 'PYEOF'
import sys, json
bead_id, status, note, raw = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
icon = "✅" if status == "pass" else "🔴"
msg = (
    f"## Baseline Guard {icon}\n\n"
    f"**{bead_id}:** {note}\n\n"
    f"```\n{raw[:600]}\n```\n\n"
    f"Baseline stored in bead notes. Regressions will be visible after your edits."
)
print(json.dumps({"hookSpecificOutput": {"systemMessage": msg}}))
PYEOF
