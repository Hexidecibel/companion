#!/bin/bash
# One-liner installer for Companion Daemon
# Usage: curl -fsSL https://raw.githubusercontent.com/Hexidecibel/companion/main/daemon/scripts/install-remote.sh | bash

set -e

echo "Downloading Companion installer..."

# Create temp directory
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

# Clone the repository
git clone --depth 1 https://github.com/Hexidecibel/companion.git "$TEMP_DIR/companion"

# Run the installer
cd "$TEMP_DIR/companion/daemon"
bash scripts/install.sh
