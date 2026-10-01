#!/bin/bash
# Notarize and staple a macOS .app or .dmg (CI, Developer ID builds).
#
# Robust to a slow Apple queue and runner network blips, which `notarytool
# submit --wait` (and Tauri's built-in notarization, which uses it) are not: a
# 53-minute first notarization died on one "-1009 offline" poll. Here the upload
# is retried, then the wait runs in rounds (each failure just polls again) until
# Accepted / Invalid or NOTARIZE_MAX_SECONDS (default 3 h). A rejection prints
# Apple's log. Stapling is retried too.
#
# Usage: macos-notarize.sh <path/Companion.app | path/Companion.dmg>
# Env:   APPLE_API_KEY (key id), APPLE_API_ISSUER, APPLE_API_KEY_PATH (.p8)
set -euo pipefail

TARGET=${1:?usage: macos-notarize.sh <file.app|file.dmg>}
: "${APPLE_API_KEY:?}" "${APPLE_API_ISSUER:?}" "${APPLE_API_KEY_PATH:?}"
AUTH=(--key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER")
TMP=${RUNNER_TEMP:-${TMPDIR:-/tmp}}

json_field() { /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get(sys.argv[1], ""))' "$1" 2>/dev/null || true; }

UPLOAD=$TARGET
if [[ "$TARGET" == *.app ]]; then
  UPLOAD="$TMP/$(basename "$TARGET" .app)-notarize.zip"
  rm -f "$UPLOAD"
  ditto -c -k --sequesterRsrc --keepParent "$TARGET" "$UPLOAD"
fi

ID=""
for i in 1 2 3 4 5; do
  if OUT=$(xcrun notarytool submit "$UPLOAD" "${AUTH[@]}" --output-format json 2>&1); then
    ID=$(printf '%s' "$OUT" | json_field id)
    [ -n "$ID" ] && break
  fi
  echo "notarytool submit failed (attempt $i): $OUT"
  sleep $((i * 20))
done
[ -n "$ID" ] || { echo "::error::notarytool submit failed for $TARGET"; exit 1; }
echo "Notarization submission for $(basename "$TARGET"): $ID"

DEADLINE=$(( $(date +%s) + ${NOTARIZE_MAX_SECONDS:-10800} ))
STATUS=""
while :; do
  # A network error or the round timeout both just lead to another poll.
  xcrun notarytool wait "$ID" "${AUTH[@]}" --timeout 15m >/dev/null 2>&1 || true
  if INFO=$(xcrun notarytool info "$ID" "${AUTH[@]}" --output-format json 2>&1); then
    STATUS=$(printf '%s' "$INFO" | json_field status)
  else
    echo "notarytool info failed (will retry): $INFO"
  fi
  echo "$(date -u +%H:%M:%S) notarization $ID: ${STATUS:-unknown}"
  case "$STATUS" in Accepted | Invalid | Rejected) break ;; esac
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    echo "::error::notarization of $(basename "$TARGET") still '${STATUS:-unknown}' at the deadline (submission $ID)"
    exit 1
  fi
  sleep 30
done

if [ "$STATUS" != Accepted ]; then
  xcrun notarytool log "$ID" "${AUTH[@]}" || true
  echo "::error::notarization of $(basename "$TARGET") $STATUS (submission $ID)"
  exit 1
fi
echo "status: Accepted"

for i in 1 2 3 4 5; do
  if xcrun stapler staple "$TARGET"; then exit 0; fi
  echo "stapler failed (attempt $i), retrying"
  sleep $((i * 15))
done
echo "::error::could not staple $TARGET"
exit 1
