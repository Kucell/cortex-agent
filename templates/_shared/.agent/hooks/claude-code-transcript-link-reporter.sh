#!/usr/bin/env bash
# Cortex Agent — Claude Code Transcript Link Reporter (audit-trail Phase 2)
# Hook target: ~/.claude/hooks/claude-code-transcript-link-reporter.sh
#
# Fires on Claude Code Stop / SessionEnd events. Reads the transcript path
# from the hook payload + 4 metadata fields (sha256, byte_size, turn_count,
# first/last timestamps) and pushes a path-only reference into the active
# run via `node .agent/skills/management-api/scripts/index.js runs transcript-link`.
#
# Privacy invariant: framework NEVER reads transcript content — only stores
# path references. Transcript bodies stay in ~/.claude/projects/<slug>/<uuid>.jsonl.
#
# Mirrors the token-reporter pattern; hook script is independent, sharing
# ~/.claude/settings.json Stop hooks array.
#
# settings.json example:
# {
#   "hooks": {
#     "Stop": [
#       {
#         "hooks": [
#           { "type": "command", "command": "~/.claude/hooks/claude-code-token-reporter.sh" },
#           { "type": "command", "command": "~/.claude/hooks/claude-code-transcript-link-reporter.sh" }
#         ]
#       }
#     ]
#   }
# }

set -euo pipefail

# Read hook payload from arg (Claude Code may pass via $1 or stdin depending on version)
PAYLOAD="${1:-}"
if [ -z "$PAYLOAD" ]; then
  PAYLOAD=$(cat)
fi
[ -z "$PAYLOAD" ] && exit 0

# Required: orchestration layer sets CLAUDE_RUN_ID when starting a session.
# Skip silently when absent (does NOT pollute state, does NOT crash session).
RUN_ID="${CLAUDE_RUN_ID:-}"
[ -z "$RUN_ID" ] && exit 0

# Extract transcript_path + session_id from payload
TRANSCRIPT=$(printf '%s' "$PAYLOAD" | jq -r '.transcript_path // ""')
SESSION_ID=$(printf '%s' "$PAYLOAD" | jq -r '.session_id // ""')
[ -f "$TRANSCRIPT" ] || exit 0

# Compute 4 metadata fields
SHA=$( (shasum -a 256 "$TRANSCRIPT" 2>/dev/null || sha256sum "$TRANSCRIPT") | awk '{print $1}' )
SIZE=$(stat -f%z "$TRANSCRIPT" 2>/dev/null || stat -c%s "$TRANSCRIPT")
TURNS=$(grep -c '"role":"user"' "$TRANSCRIPT" 2>/dev/null || echo 0)
FIRST=$(head -1 "$TRANSCRIPT" | jq -r '.timestamp // ""' 2>/dev/null || echo "")
LAST=$(tail -1 "$TRANSCRIPT" | jq -r '.timestamp // ""' 2>/dev/null || echo "")

# Project root discovery:
#   Preferred: CORTEX_PROJECT_DIR env var (set by orchestration layer when
#     starting Claude Code session — reliable, no path-decoding guesswork).
#   Fallback:  decode ~/.claude/projects/<encoded-cwd>/ → /encoded-cwd
#     (Claude Code replaces path slashes with `-`, prepends `-` for absolute paths).
# Example: ~/.claude/projects/-Users-xueyq-myworks-cortex-agent/<uuid>.jsonl
#   → /Users/xueyq/myworks/cortex-agent
if [ -n "${CORTEX_PROJECT_DIR:-}" ] && [ -d "$CORTEX_PROJECT_DIR" ]; then
  cd "$CORTEX_PROJECT_DIR"
else
  CLAUDE_PROJECT_DIR=$(dirname "$TRANSCRIPT")
  ENCODED_CWD=$(basename "$CLAUDE_PROJECT_DIR")
  # Claude Code replaces / with - in cwd paths. Decoding reverses this BUT
  # is ambiguous when path components themselves contain dashes (e.g. cortex-agent).
  # Best-effort: try decoded; if missing, fall back to checking sibling dirs.
  DECODED_CWD="/$(printf '%s' "$ENCODED_CWD" | tr '-' '/')"
  if [ -d "$DECODED_CWD" ]; then
    cd "$DECODED_CWD"
  else
    # Last-resort fallback: use parent of ~/.claude (top-level Claude home is sibling to project)
    CLAUDE_HOME=$(dirname "$(dirname "$CLAUDE_PROJECT_DIR")")
    cd "$(dirname "$CLAUDE_HOME")"
  fi
fi

# Opt-out hook (per-project): if .agent/config/audit-trail.yaml contains 'enabled: false',
# skip silently. Best-effort grep (yaml is whitespace-tolerant); explicit 'false' line wins.
if [ -f .agent/config/audit-trail.yaml ] && grep -qE '^\s*enabled\s*:\s*false' .agent/config/audit-trail.yaml; then
  exit 0
fi

# Push reference (CLI failure is non-fatal; exit 0 always so session is not interrupted)
node .agent/skills/management-api/scripts/index.js runs transcript-link \
  --gate agent --source claude-code \
  --run-id "$RUN_ID" --session-id "$SESSION_ID" \
  --transcript-path "$TRANSCRIPT" \
  --transcript-sha256 "$SHA" --byte-size "$SIZE" --turn-count "$TURNS" \
  --first-turn-at "$FIRST" --last-turn-at "$LAST" \
  >/dev/null 2>&1 || {
  echo "transcript-link reporter failed (non-fatal)" >&2
  exit 0
}