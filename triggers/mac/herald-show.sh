#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Show Herald's Last Session
# @raycast.mode silent
# @raycast.argument1 { "type": "text", "placeholder": "Session (optional)", "optional": true }

# Optional parameters:
# @raycast.packageName Herald
# @raycast.description Open the session Herald last talked about (or the one you type) on the active device.
# @raycast.author Companion

# Fires the Herald "show" trigger. Setup: triggers/README.md.
exec "$(dirname "$0")/herald-trigger.sh" show "${1:-}"
