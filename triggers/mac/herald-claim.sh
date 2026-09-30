#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Herald Take Control
# @raycast.mode silent

# Optional parameters:
# @raycast.packageName Herald
# @raycast.description Make this Mac the active Herald device (tones, hands-free, triggers).
# @raycast.author Companion

# Needs ~/.config/herald-trigger/device (this Mac's name in Herald). Setup: triggers/README.md.
exec "$(dirname "$0")/herald-trigger.sh" claim
