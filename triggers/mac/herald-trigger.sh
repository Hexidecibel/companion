#!/bin/bash
# herald-trigger.sh ACTION - fire a Herald remote trigger from a Mac (or any
# Unix shell). Used by the Raycast script commands next to it; also fine from
# a terminal, Keyboard Maestro, BetterTouchTool or a Shortcuts "Run Shell Script".
#
#   ACTION: toggle | brief | listen | stop | repeat
#
# Daemon URL (not secret): $HERALD_TRIGGER_URL, else the first line of
#   ~/.config/herald-trigger/url   (e.g. https://dev.cush.rocks)
# Token (secret): $HERALD_TRIGGER_TOKEN, else the macOS Keychain item
#   service "herald-trigger", account $USER
#   (security add-generic-password -s herald-trigger -a "$USER" -w   # prompts)
# The token is passed to curl on stdin (a config file), never on its command
# line, so it does not show up in `ps`.
set -euo pipefail

action="${1:-toggle}"
case "$action" in
  toggle|brief|listen|stop|repeat) ;;
  *) echo "Herald: unknown action '$action'"; exit 2 ;;
esac

url="${HERALD_TRIGGER_URL:-}"
if [ -z "$url" ] && [ -r "$HOME/.config/herald-trigger/url" ]; then
  url="$(head -n1 "$HOME/.config/herald-trigger/url" | tr -d '[:space:]')"
fi
if [ -z "$url" ]; then
  echo "Herald: set the daemon URL in ~/.config/herald-trigger/url"
  exit 1
fi
url="${url%/}"

token="${HERALD_TRIGGER_TOKEN:-}"
if [ -z "$token" ] && command -v security >/dev/null 2>&1; then
  token="$(security find-generic-password -s herald-trigger -a "$USER" -w 2>/dev/null || true)"
fi
if [ -z "$token" ]; then
  echo "Herald: no trigger token (Keychain item 'herald-trigger' not found)"
  exit 1
fi

body="$(mktemp)"
trap 'rm -f "$body"' EXIT
code="$(
  printf 'header = "Authorization: Bearer %s"\n' "$token" |
    curl -sS --max-time 5 -o "$body" -w '%{http_code}' -K - \
      -X POST -H 'Content-Type: application/json' \
      --data "{\"action\":\"$action\"}" "$url/herald/trigger" 2>/dev/null
)" || code="000"
unset token

if [ "$code" = "200" ]; then
  case "$action" in
    toggle) echo "Herald: toggled" ;;
    brief) echo "Herald: briefing" ;;
    listen) echo "Herald: listening" ;;
    stop) echo "Herald: stopped" ;;
    repeat) echo "Herald: repeating" ;;
  esac
  exit 0
fi
msg="$(sed -n 's/.*"error"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$body" | head -n1)"
case "$code" in
  000) echo "Herald: cannot reach $url" ;;
  *) echo "Herald: ${msg:-HTTP $code} ($code)" ;;
esac
exit 1
