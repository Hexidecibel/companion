#!/usr/bin/env bash
# PreToolUse guard: block reflexive companion daemon restart/stop/start.
#
# Restarting or stopping the companion daemon drops in-flight debugging state
# (e.g. pending-AUQ tmux-pane scrape state that is NOT on disk), and historically
# wiped spawned tmux sessions. Require explicit user sign-off first.
#
# Reads PreToolUse JSON from stdin. Allows = exit 0 with no output.
# Deny = emit structured permissionDecision JSON and exit 0.

set -euo pipefail

input="$(cat)"

# Extract the command being run; default to empty if absent.
command="$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || true)"

# Nothing to inspect -> allow.
if [ -z "$command" ]; then
  exit 0
fi

# Explicit override escape hatch: user has approved.
case "$command" in
  *COMPANION_ALLOW_RESTART*)
    exit 0
    ;;
esac

deny() {
  reason="$1"
  jq -nc --arg r "$reason" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  exit 0
}

reason="Blocked: restarting/stopping the companion daemon drops in-flight debugging state (e.g. pending-AUQ tmux-pane scrape state that isn't on disk) and historically wiped spawned tmux sessions. Ask the user for explicit sign-off first. To override after approval, include COMPANION_ALLOW_RESTART=1 in the command."

# systemctl [--user] (restart|stop) ... companion
if printf '%s' "$command" | grep -Eq 'systemctl([[:space:]]+--user)?[[:space:]]+(restart|stop)[[:space:]].*companion'; then
  deny "$reason"
fi

# bin/companion or companion followed by restart|stop|start
if printf '%s' "$command" | grep -Eq '(^|[[:space:]/])(bin/)?companion[[:space:]]+(restart|stop|start)([[:space:]]|$)'; then
  deny "$reason"
fi

# Anything else -> allow.
exit 0
