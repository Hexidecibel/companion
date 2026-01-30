#!/bin/bash
set -e

echo "Building Companion Daemon..."

cd "$(dirname "$0")/.."

# Install dependencies
echo "Installing dependencies..."
npm install

# Compile TypeScript
echo "Compiling TypeScript..."
npm run build

echo "Build complete! Output in ./dist/"

# Optional: Create standalone binary
if [ "$1" == "--binary" ]; then
  echo "Creating standalone binary..."
  npm run pkg
  echo "Binary created: daemon-linux-x64"
fi
