#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Herald Brief
# @raycast.mode silent

# Optional parameters:
# @raycast.packageName Herald
# @raycast.description Spoken rundown of what is new across your sessions.
# @raycast.author Companion

# Fires the Herald "brief" trigger on the active device. Setup: triggers/README.md.
exec "$(dirname "$0")/herald-trigger.sh" brief
