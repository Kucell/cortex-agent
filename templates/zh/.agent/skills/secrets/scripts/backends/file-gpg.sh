#!/usr/bin/env bash
# Backend: file-gpg — store secrets in `$CORTEX_SECRET_DIR/<ref>.gpg`
# using gpg-agent symmetric encryption (passphrase supplied via agent).
# Cross-platform; no keychain / secret-service required.
# Path: $CORTEX_SECRET_DIR or $XDG_DATA_HOME/cortex-agent/secrets, fallback $HOME/.local/share/cortex-agent/secrets.
set -euo pipefail
PAYLOAD="${1:-}"
if [ -z "$PAYLOAD" ]; then echo '{"ok":false,"error":"missing_payload"}'; exit 1; fi
if ! command -v gpg >/dev/null 2>&1; then
  echo '{"ok":false,"error":"gpg_not_installed"}'; exit 1
fi
ACTION=$(printf '%s' "$PAYLOAD" | sed -n 's/.*"action":"\([^\"]*\)".*/\1/p')
REF=$(printf '%s' "$PAYLOAD" | sed -n 's/.*"ref":"\([^\"]*\)".*/\1/p')
VALUE=$(printf '%s' "$PAYLOAD" | sed -n 's/.*"value":"\(.*\)".*/\1/p' | head -1)
ROOT_DIR="${CORTEX_SECRET_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/cortex-agent/secrets}"
mkdir -p "$ROOT_DIR"
FILE="$ROOT_DIR/$(printf '%s' "$REF" | tr '/ ' '__').gpg"
case "$ACTION" in
  get)
    if [ ! -f "$FILE" ]; then echo "{\"ok\":false,\"error\":\"not_found\",\"file\":\"$FILE\"}"; exit 1; fi
    VALUE=$(gpg --batch --pinentry-mode loopback --passphrase-file <(printf '%s' "${CORTEX_SECRET_PASSPHRASE:-cortex-agent-default}") \
            --decrypt "$FILE" 2>/dev/null) \
      || { echo '{"ok":false,"error":"gpg_decrypt_failed"}'; exit 1; }
    printf '{"ok":true,"action":"get","ref":"%s","value":"%s"}\n' "$REF" "$VALUE"
    ;;
  store)
    if [ -z "$VALUE" ]; then echo '{"ok":false,"error":"missing_value_for_store"}'; exit 1; fi
    printf '%s' "$VALUE" | gpg --batch --pinentry-mode loopback \
      --passphrase-file <(printf '%s' "${CORTEX_SECRET_PASSPHRASE:-cortex-agent-default}") \
      --symmetric --output "$FILE" >/dev/null 2>&1 \
      || { echo '{"ok":false,"error":"gpg_encrypt_failed"}'; exit 1; }
    chmod 600 "$FILE" || true
    printf '{"ok":true,"action":"store","ref":"%s","file":"%s"}\n' "$REF" "$FILE"
    ;;
  rotate)
    rm -f "$FILE"
    printf '{"ok":true,"action":"rotate","ref":"%s","file":"%s"}\n' "$REF" "$FILE"
    ;;
  delete)
    rm -f "$FILE"
    printf '{"ok":true,"action":"delete","ref":"%s","file":"%s"}\n' "$REF" "$FILE"
    ;;
  *)
    echo "{\"ok\":false,\"error\":\"unknown_action\",\"action\":\"$ACTION\"}"; exit 1 ;;
esac
