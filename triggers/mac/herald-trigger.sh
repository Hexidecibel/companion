#!/bin/bash
# herald-trigger.sh ACTION - fire a Herald remote trigger from a Mac (or any
# Unix shell). Used by the Raycast script commands next to it; also fine from
# a terminal, Keyboard Maestro, BetterTouchTool or a Shortcuts "Run Shell Script".
#
#   ACTION: toggle | brief | listen | stop | repeat | claim
#
# Daemon URL (not secret): $HERALD_TRIGGER_URL, else the first line of
#   ~/.config/herald-trigger/url   (e.g. https://dev.cush.rocks)
# Token (secret): $HERALD_TRIGGER_TOKEN, else the macOS Keychain item
#   service "herald-trigger", account $USER
#   (security add-generic-password -s herald-trigger -a "$USER" -w   # prompts)
# This machine's device name in Herald (optional): $HERALD_TRIGGER_DEVICE, else
#   ~/.config/herald-trigger/device   (e.g. Work Mac; Herald menu > Devices > Rename)
#   When set, every trigger first makes that device active (pinned; set
#   HERALD_TRIGGER_PIN=false to not pin), so the hotkey acts on THIS Mac.
#   `claim` needs it.
# The token is passed to curl on stdin (a config file), never on its command
# line, so it does not show up in `ps`.
#
# Signed mode (optional, off by default): HERALD_TRIGGER_SIGNED=true, or a line
# "true" in ~/.config/herald-trigger/signed. The token is then never sent:
# each request carries X-Herald-Ts + X-Herald-Sig (HMAC-SHA256 keyed with the
# token's SHA-256, over "<ts>.<action>.<device>"), which the daemon refuses
# after 60 s or on reuse. Needs perl (built in on macOS) and a correct clock.
set -euo pipefail

action="${1:-toggle}"
case "$action" in
  toggle|brief|listen|stop|repeat|claim) ;;
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

device="${HERALD_TRIGGER_DEVICE:-}"
if [ -z "$device" ] && [ -r "$HOME/.config/herald-trigger/device" ]; then
  device="$(head -n1 "$HOME/.config/herald-trigger/device" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
fi
if [ "$action" = "claim" ] && [ -z "$device" ]; then
  echo "Herald: set this Mac's device name in ~/.config/herald-trigger/device"
  exit 1
fi
json="{\"action\":\"$action\""
if [ -n "$device" ]; then
  esc="$(printf '%s' "$device" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  pin=true
  [ "${HERALD_TRIGGER_PIN:-true}" = "false" ] && pin=false
  json="$json,\"device\":\"$esc\",\"pin\":$pin"
fi
json="$json}"

signed="${HERALD_TRIGGER_SIGNED:-}"
if [ -z "$signed" ] && [ -r "$HOME/.config/herald-trigger/signed" ]; then
  signed="$(head -n1 "$HOME/.config/herald-trigger/signed" | tr -d '[:space:]')"
fi
if [ "$signed" = "true" ] || [ "$signed" = "1" ]; then
  ts="$(date +%s)"
  # The token goes to perl on stdin, never on a command line.
  sig="$(printf '%s' "$token" | perl -MDigest::SHA=hmac_sha256_hex,sha256_hex -e \
    'my $t = <STDIN>; $t =~ s/\s+$//; print hmac_sha256_hex($ARGV[0], sha256_hex($t));' \
    "$ts.$action.$device")"
  auth_headers="$(printf 'header = "X-Herald-Ts: %s"\nheader = "X-Herald-Sig: %s"\n' "$ts" "$sig")"
else
  auth_headers="$(printf 'header = "Authorization: Bearer %s"\n' "$token")"
fi

body="$(mktemp)"
trap 'rm -f "$body"' EXIT
code="$(
  printf '%s\n' "$auth_headers" |
    curl -sS --max-time 5 -o "$body" -w '%{http_code}' -K - \
      -X POST -H 'Content-Type: application/json' \
      --data "$json" "$url/herald/trigger" 2>/dev/null
)" || code="000"
unset token auth_headers

if [ "$code" = "200" ]; then
  case "$action" in
    toggle) echo "Herald: toggled" ;;
    brief) echo "Herald: briefing" ;;
    listen) echo "Herald: listening" ;;
    stop) echo "Herald: stopped" ;;
    repeat) echo "Herald: repeating" ;;
    claim) echo "Herald: now on ${device}" ;;
  esac
  exit 0
fi
msg="$(sed -n 's/.*"error"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$body" | head -n1)"
case "$code" in
  000) echo "Herald: cannot reach $url" ;;
  *) echo "Herald: ${msg:-HTTP $code} ($code)" ;;
esac
exit 1
