#!/bin/bash
# careful-guard.sh — Pre-hook that blocks destructive shell commands
# Reads Claude Code PreToolCall JSON from stdin, checks for dangerous patterns.
# Exit 0 = allow, Exit 2 = block (message shown to user/agent)

set -euo pipefail

INPUT=$(cat)

# Only check Bash tool calls
TOOL_NAME=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_name',''))" 2>/dev/null || echo "")
if [ "$TOOL_NAME" != "Bash" ]; then
  exit 0
fi

CMD=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null || echo "")

if [ -z "$CMD" ]; then
  exit 0
fi

# --- Destructive pattern checks ---

# rm -rf with broad targets (allow rm -rf on safe dirs like node_modules, dist, .parts)
if echo "$CMD" | grep -qE 'rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|--force\s+)' ; then
  # Allow known safe cleanup targets
  if echo "$CMD" | grep -qE 'rm\s+-rf\s+(node_modules|dist|\.next|\.turbo|\.parts|/tmp/|audit-findings/\.parts|qa-reports/\.parts|screenshots/)'; then
    exit 0
  fi
  echo "CAREFUL: Detected force-delete command: $CMD" >&2
  echo "If you need this, ask the user to approve it explicitly." >&2
  exit 2
fi

# git push --force (any variant)
if echo "$CMD" | grep -qE 'git\s+push\s+.*--force|git\s+push\s+-f\b'; then
  echo "CAREFUL: Force-push can overwrite remote history: $CMD" >&2
  echo "Use 'git push --force-with-lease' or ask the user first." >&2
  exit 2
fi

# git reset --hard
if echo "$CMD" | grep -qE 'git\s+reset\s+--hard'; then
  echo "CAREFUL: git reset --hard discards all uncommitted changes: $CMD" >&2
  echo "Consider 'git stash' first, or ask the user to approve." >&2
  exit 2
fi

# git checkout -- . (discard all changes)
if echo "$CMD" | grep -qE 'git\s+checkout\s+--\s+\.'; then
  echo "CAREFUL: This discards ALL local file changes: $CMD" >&2
  exit 2
fi

# git clean -f (remove untracked files)
if echo "$CMD" | grep -qE 'git\s+clean\s+.*-[a-zA-Z]*f'; then
  echo "CAREFUL: git clean -f permanently removes untracked files: $CMD" >&2
  exit 2
fi

# git branch -D (force delete branch)
if echo "$CMD" | grep -qE 'git\s+branch\s+-D\b'; then
  echo "CAREFUL: Force-deleting a branch cannot be easily undone: $CMD" >&2
  exit 2
fi

# DROP TABLE / DROP DATABASE
if echo "$CMD" | grep -qiE 'DROP\s+(TABLE|DATABASE|SCHEMA)'; then
  echo "CAREFUL: Destructive SQL detected: $CMD" >&2
  exit 2
fi

# pkill/kill -9 on broad targets (allow specific PIDs and known safe patterns)
if echo "$CMD" | grep -qE '(pkill|killall)\s+-9\s+' ; then
  # Allow known safe targets (playwright, chromium, vite)
  if echo "$CMD" | grep -qE '(pkill|killall)\s+-9\s+.*(Chromium|playwright|vite|node)'; then
    exit 0
  fi
  echo "CAREFUL: Force-killing processes broadly: $CMD" >&2
  exit 2
fi

# All clear
exit 0
