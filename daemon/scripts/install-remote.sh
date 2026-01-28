#!/bin/bash
# One-liner installer for Claude Companion Daemon
# Usage: curl -fsSL https://raw.githubusercontent.com/Hexidecibel/claude-companion/main/daemon/scripts/install-remote.sh | bash

set -e

echo "Downloading Claude Companion installer..."

# Create temp directory
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

# Clone the repository
git clone --depth 1 https://github.com/Hexidecibel/claude-companion.git "$TEMP_DIR/claude-companion"

# Run the installer
cd "$TEMP_DIR/claude-companion/daemon"
bash scripts/install.sh
