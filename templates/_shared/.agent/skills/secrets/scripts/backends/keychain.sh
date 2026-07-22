#!/usr/bin/env bash
# Backend: macOS keychain via `security(1)`.
# JSON protocol: {"action":"get","ref":"gitea-pr","service":"gitea-..."}
#               {"action":"store","ref":"...", "service":"...", "value":"...", "account":"xueyq"}
#               {"action":"rotate","ref":"...","reason":"..."}
#               {"action":"delete","ref":"...","service":"..."}
# Output: JSON {"ok":true,"value":"...","ref":"..."} or {"ok":false,"error":"reason"}.
# Never print the value to stderr; never echo it.
set -euo pipefail
PAYLOAD="${1:-}"
if [ -z "$PAYLOAD" ]; then echo '{"ok":false,"error":"missing_payload"}'; exit 1; fi
case "$(uname -s)" in
  Darwin) ;;
  *) echo '{"ok":false,"error":"keychain_backend_unsupported_on_platform"}'; exit 1 ;;
esac
ACTION=$(printf '%s' "$PAYLOAD" | sed -n 's/.*"action":"\([^\"]*\)".*/\1/p')
REF=$(printf '%s' "$PAYLOAD" | sed -n 's/.*"ref":"\([^\"]*\)".*/\1/p')
SERVICE=$(printf '%s' "$PAYLOAD" | sed -n 's/.*"service":"\([^\"]*\)".*/\1/p')
ACCOUNT=$(printf '%s' "$PAYLOAD" | sed -n 's/.*"account":"\([^\"]*\)".*/\1/p' | head -1)
VALUE=$(printf '%s' "$PAYLOAD" | sed -n 's/.*"value":"\(.*\)".*/\1/p' | head -1)
if [ -z "$ACTION" ] || [ -z "$REF" ] || [ -z "$SERVICE" ]; then
  echo '{"ok":false,"error":"missing_action_ref_or_service"}'; exit 1
fi
case "$ACTION" in
  get)
    VALUE=$(security find-generic-password -s "$SERVICE" -w 2>/dev/null) \
      || { echo "{\"ok\":false,\"error\":\"not_found\",\"service\":\"$SERVICE\"}"; exit 1; }
    printf '{"ok":true,"action":"get","ref":"%s","value":"%s"}\n' "$REF" "$VALUE"
    ;;
  store)
    if [ -z "$VALUE" ]; then echo '{"ok":false,"error":"missing_value_for_store"}'; exit 1; fi
    security delete-generic-password -s "$SERVICE" >/dev/null 2>&1 || true
    security add-generic-password -s "$SERVICE" -a "${ACCOUNT:-xueyq}" -w "$VALUE" \
      >/dev/null 2>&1 \
      || { echo '{"ok":false,"error":"keychain_store_failed"}'; exit 1; }
    printf '{"ok":true,"action":"store","ref":"%s","service":"%s"}\n' "$REF" "$SERVICE"
    ;;
  rotate)
    security delete-generic-password -s "$SERVICE" >/dev/null 2>&1 || true
    printf '{"ok":true,"action":"rotate","ref":"%s","service":"%s"}\n' "$REF" "$SERVICE"
    ;;
  delete)
    security delete-generic-password -s "$SERVICE" >/dev/null 2>&1 || true
    printf '{"ok":true,"action":"delete","ref":"%s","service":"%s"}\n' "$REF" "$SERVICE"
    ;;
  *)
    echo "{\"ok\":false,\"error\":\"unknown_action\",\"action\":\"$ACTION\"}"; exit 1 ;;
esac
