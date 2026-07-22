#!/usr/bin/env bash
# Backend: Linux Secret Service via `secret-tool(1)`.
# Same JSON protocol as keychain backend.
set -euo pipefail
PAYLOAD="${1:-}"
if [ -z "$PAYLOAD" ]; then echo '{"ok":false,"error":"missing_payload"}'; exit 1; fi
if ! command -v secret-tool >/dev/null 2>&1; then
  echo '{"ok":false,"error":"secret_tool_not_installed"}'; exit 1
fi
ACTION=$(printf '%s' "$PAYLOAD" | sed -n 's/.*"action":"\([^\"]*\)".*/\1/p')
REF=$(printf '%s' "$PAYLOAD" | sed -n 's/.*"ref":"\([^\"]*\)".*/\1/p')
SERVICE=$(printf '%s' "$PAYLOAD" | sed -n 's/.*"service":"\([^\"]*\)".*/\1/p')
ACCOUNT=$(printf '%s' "$PAYLOAD" | sed -n 's/.*"account":"\([^\"]*\)".*/\1/p' | head -1)
VALUE=$(printf '%s' "$PAYLOAD" | sed -n 's/.*"value":"\(.*\)".*/\1/p' | head -1)
case "$ACTION" in
  get)
    if ! VALUE=$(secret-tool lookup service "$SERVICE" 2>/dev/null); then
      echo "{\"ok\":false,\"error\":\"not_found\",\"service\":\"$SERVICE\"}"; exit 1
    fi
    printf '{"ok":true,"action":"get","ref":"%s","value":"%s"}\n' "$REF" "$VALUE"
    ;;
  store)
    if [ -z "$VALUE" ]; then echo '{"ok":false,"error":"missing_value_for_store"}'; exit 1; fi
    secret-tool clear service "$SERVICE" >/dev/null 2>&1 || true
    secret-tool store --label="$REF" service "$SERVICE" <<<"$VALUE" >/dev/null 2>&1 \
      || { echo '{"ok":false,"error":"secret_service_store_failed"}'; exit 1; }
    printf '{"ok":true,"action":"store","ref":"%s","service":"%s"}\n' "$REF" "$SERVICE"
    ;;
  rotate)
    secret-tool clear service "$SERVICE" >/dev/null 2>&1 || true
    printf '{"ok":true,"action":"rotate","ref":"%s","service":"%s"}\n' "$REF" "$SERVICE"
    ;;
  delete)
    secret-tool clear service "$SERVICE" >/dev/null 2>&1 || true
    printf '{"ok":true,"action":"delete","ref":"%s","service":"%s"}\n' "$REF" "$SERVICE"
    ;;
  *)
    echo "{\"ok\":false,\"error\":\"unknown_action\",\"action\":\"$ACTION\"}"; exit 1 ;;
esac
