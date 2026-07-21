#!/usr/bin/env bash
# Backend: env — direct read of process.env[<REF_NAME>].
# Suitable for CI / fallback only; secrets stored unencrypted in env.
# REF is looked up as CORTEX_SECRET_<REF_UPPER_SNAKE_CASE>.
set -euo pipefail
PAYLOAD="${1:-}"
if [ -z "$PAYLOAD" ]; then echo '{"ok":false,"error":"missing_payload"}'; exit 1; fi
ACTION=$(printf '%s' "$PAYLOAD" | sed -n 's/.*"action":"\([^\"]*\)".*/\1/p')
REF=$(printf '%s' "$PAYLOAD" | sed -n 's/.*"ref":"\([^\"]*\)".*/\1/p')
if [ -z "$ACTION" ] || [ -z "$REF" ]; then
  echo '{"ok":false,"error":"missing_action_or_ref"}'; exit 1
fi
# Convert "gitea-pr" → "GITEA_PR"
KEY="CORTEX_SECRET_$(printf '%s' "$REF" | tr '[:lower:]-' '[:upper:]_')"
case "$ACTION" in
  get|store)
    if [ "$ACTION" = "store" ]; then
      echo '{"ok":false,"error":"env_backend_is_read_only_store_via_dotenv_or_secret_manager"}'; exit 1
    fi
    if [ -z "${!KEY:-}" ]; then echo "{\"ok\":false,\"error\":\"not_found\",\"env_key\":\"$KEY\"}"; exit 1; fi
    printf '{"ok":true,"action":"get","ref":"%s","value":"%s"}\n' "$REF" "${!KEY}"
    ;;
  rotate)
    unset "$KEY" 2>/dev/null || true
    printf '{"ok":true,"action":"rotate","ref":"%s","env_key":"%s"}\n' "$REF" "$KEY"
    ;;
  delete)
    unset "$KEY" 2>/dev/null || true
    printf '{"ok":true,"action":"delete","ref":"%s","env_key":"%s"}\n' "$REF" "$KEY"
    ;;
  *)
    echo "{\"ok\":false,\"error\":\"unknown_action\",\"action\":\"$ACTION\"}"; exit 1 ;;
esac
