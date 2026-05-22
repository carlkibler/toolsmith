#!/usr/bin/env bash
#
# PostToolUse(Edit|Write) hook: Cheap Watcher
#
# An adversarial cheap-model co-pilot that watches every edit.
# Rate-limited: fires at most once per 120 seconds per project.
# Only activates when an in-progress bead exists and >= 10 lines have changed.
#
# Uses ask-cerebras (fastest/cheapest); falls back to ask-gemini.

set -uo pipefail

INPUT=$(cat)

command -v bd &>/dev/null || exit 0

TOOL=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_name',''))" 2>/dev/null)
[[ "$TOOL" != "Edit" && "$TOOL" != "Write" ]] && exit 0

BEAD_ID=$(bd list --status=in_progress --json 2>/dev/null \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['id'] if d else '')" 2>/dev/null)
[[ -z "$BEAD_ID" ]] && exit 0

# Rate limit: one check per 120s per project
LOCK_DIR=$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")
LOCK_FILE="/tmp/cheap-watcher-$(echo "$LOCK_DIR" | md5sum | cut -c1-8).ts"
NOW=$(date +%s)
if [[ -f "$LOCK_FILE" ]]; then
    LAST=$(cat "$LOCK_FILE" 2>/dev/null || echo 0)
    [[ $((NOW - LAST)) -lt 120 ]] && exit 0
fi
echo "$NOW" > "$LOCK_FILE"

# Only check when there's meaningful change (>= 10 lines)
CHANGED=$(git diff --stat 2>/dev/null | tail -1 | grep -oE '[0-9]+ insertion|[0-9]+ deletion' | grep -oE '[0-9]+' | paste -sd+ | bc 2>/dev/null || echo 0)
[[ "${CHANGED:-0}" -lt 10 ]] && exit 0

BEAD_DESC=$(bd show "$BEAD_ID" --json 2>/dev/null \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print((d[0].get('description') or '')[:1000])" 2>/dev/null)
[[ -z "$BEAD_DESC" ]] && exit 0

# Get changed files + brief diff
CHANGED_FILES=$(git diff --name-only 2>/dev/null | head -10 | tr '\n' ', ')
DIFF_SNIPPET=$(git diff 2>/dev/null | head -c 3000)

PROMPT="You are an adversarial code reviewer watching an AI agent work.

Bead ${BEAD_ID} goal:
${BEAD_DESC}

Files changed: ${CHANGED_FILES}

Diff snippet:
${DIFF_SNIPPET}

Does the work so far appear aligned with the bead goal? Reply with ONE of:
- ON TRACK: [brief reason, max 10 words]
- DRIFTING: [specific concern, max 15 words]
- OFF TRACK: [what went wrong, max 15 words]"

# Use cerebras if available, fall back to gemini
if command -v ask-cerebras &>/dev/null; then
    VERDICT=$(echo "$PROMPT" | timeout 15 ask-cerebras 2>/dev/null | head -3)
elif command -v ask-gemini &>/dev/null; then
    VERDICT=$(echo "$PROMPT" | timeout 20 ask-gemini 2>/dev/null | head -3)
else
    exit 0
fi

[[ -z "$VERDICT" ]] && exit 0

# Only surface warnings, stay silent on ON TRACK
if echo "$VERDICT" | grep -qiE '^ON TRACK'; then
    exit 0
fi

python3 - "$BEAD_ID" "$VERDICT" << 'PYEOF'
import sys, json
bead_id, verdict = sys.argv[1], sys.argv[2]
icon = "🔶" if "DRIFTING" in verdict.upper() else "🔴"
msg = f"## Cheap Watcher {icon} — {bead_id}\n\n{verdict}"
print(json.dumps({"hookSpecificOutput": {"systemMessage": msg}}))
PYEOF
