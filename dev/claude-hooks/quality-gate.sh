#!/usr/bin/env bash
#
# Stop hook: Quality Gate + Structured Learning Extraction
#
# On every stop:
#   1. Finds the first in-progress bead
#   2. Compares its description against git diff via ask-gemini
#   3. Reports any unmet requirements
#   4. Prompts for structured learning extraction
#
# Degrades gracefully: no bead, no diff, or ask-gemini unavailable → silent exit

set -uo pipefail

INPUT=$(cat)

command -v bd &>/dev/null || exit 0
command -v ask-gemini &>/dev/null || exit 0

BEAD_ID=$(bd list --status=in_progress --json 2>/dev/null \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['id'] if d else '')" 2>/dev/null)
[[ -z "$BEAD_ID" ]] && exit 0

BEAD_DESC=$(bd show "$BEAD_ID" --json 2>/dev/null \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print((d[0].get('description') or '')[:2000])" 2>/dev/null)
[[ -z "$BEAD_DESC" ]] && exit 0

# Prefer staged+unstaged diff; fall back to HEAD diff for worktrees
GIT_DIFF=$(git diff 2>/dev/null | head -c 8000)
[[ -z "$GIT_DIFF" ]] && GIT_DIFF=$(git diff HEAD 2>/dev/null | head -c 8000)
[[ -z "$GIT_DIFF" ]] && exit 0

PROMPT="Bead ${BEAD_ID} description:
${BEAD_DESC}

Git diff (truncated):
${GIT_DIFF}

Task: List any requirements from the bead description that are NOT evidenced in the diff. One line per gap. If all requirements are met, respond with exactly: All requirements met."

GAPS=$(echo "$PROMPT" | timeout 20 ask-gemini 2>/dev/null | head -c 800)
[[ -z "$GAPS" ]] && exit 0

LEARNING_CMD="bd comments add ${BEAD_ID} \"LEARNED: [specific problem] → [specific solution]. [context why]\""

python3 - "$BEAD_ID" "$GAPS" "$LEARNING_CMD" << 'PYEOF'
import sys, json
bead_id, gaps, lcmd = sys.argv[1], sys.argv[2], sys.argv[3]
if gaps.strip().lower().startswith("all requirements met"):
    icon = "✅"
    body = "All requirements met."
else:
    icon = "⚠️"
    body = gaps.strip()
msg = (
    f"## Quality Gate: {bead_id} {icon}\n\n"
    f"{body}\n\n"
    f"**Capture a learning before stopping:**\n"
    f"`{lcmd}`"
)
print(json.dumps({"hookSpecificOutput": {"systemMessage": msg}}))
PYEOF
