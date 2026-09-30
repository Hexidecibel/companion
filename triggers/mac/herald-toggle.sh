#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Herald Toggle
# @raycast.mode silent

# Optional parameters:
# @raycast.packageName Herald
# @raycast.description Herald talking: stop. Listening: cancel. Otherwise: listen for one question.
# @raycast.author Companion

# Fires the Herald "toggle" trigger on the active device. Setup: triggers/README.md.
exec "$(dirname "$0")/herald-trigger.sh" toggle
