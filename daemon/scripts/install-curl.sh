#!/usr/bin/env bash
# Companion Daemon - One-liner installer
# Usage: curl -fsSL https://raw.githubusercontent.com/Hexidecibel/companion/main/daemon/scripts/install-curl.sh | bash
set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BLUE}${BOLD}"
echo "  ╔═══════════════════════════════════════╗"
echo "  ║       Companion Daemon Installer      ║"
echo "  ╚═══════════════════════════════════════╝"
echo -e "${NC}"

# Check for required tools
check_deps() {
  local missing=()
  command -v node &>/dev/null || missing+=("node")
  command -v npm &>/dev/null || missing+=("npm")
  command -v git &>/dev/null || missing+=("git")
  command -v tmux &>/dev/null || missing+=("tmux")

  if [[ ${#missing[@]} -gt 0 ]]; then
    echo -e "${RED}Missing required tools: ${missing[*]}${NC}"
    echo ""
    echo "Install them first:"
    if [[ "$OSTYPE" == "darwin"* ]]; then
      echo "  brew install node tmux git"
    elif command -v apt &>/dev/null; then
      echo "  sudo apt install nodejs npm tmux git"
    elif command -v dnf &>/dev/null; then
      echo "  sudo dnf install nodejs npm tmux git"
    else
      echo "  Install Node.js 18+, npm, tmux, and git"
    fi
    exit 1
  fi

  # Check node version
  NODE_MAJOR=$(node -v | cut -d. -f1 | tr -d 'v')
  if [[ $NODE_MAJOR -lt 18 ]]; then
    echo -e "${RED}Node.js 18+ required (found $(node -v))${NC}"
    exit 1
  fi

  echo -e "${GREEN}✓${NC} Dependencies OK (node $(node -v), npm $(npm -v))"
}

# Install via npm (preferred)
install_npm() {
  echo ""
  echo -e "${BLUE}Installing via npm...${NC}"

  # Try global install first, fall back to local
  if npm install -g @hexidecibel/companion 2>/dev/null; then
    echo -e "${GREEN}✓${NC} Installed globally via npm"
    return 0
  fi

  # Global failed, try without sudo (nvm users)
  echo -e "${YELLOW}Global install failed, trying user install...${NC}"

  # Clone and install locally
  install_git
}

# Install via git clone
install_git() {
  echo ""
  echo -e "${BLUE}Installing via git clone...${NC}"

  INSTALL_DIR="$HOME/.companion"

  if [[ -d "$INSTALL_DIR/daemon" ]]; then
    echo -e "${YELLOW}Existing installation found, updating...${NC}"
    cd "$INSTALL_DIR"
    git pull --ff-only 2>/dev/null || git fetch origin main && git reset --hard origin/main
  else
    echo "Cloning repository..."
    git clone --depth 1 https://github.com/Hexidecibel/companion.git "$INSTALL_DIR"
  fi

  cd "$INSTALL_DIR/daemon"

  echo "Installing dependencies..."
  npm install --silent 2>/dev/null || npm install

  echo "Building..."
  npm run build --silent 2>/dev/null || npm run build

  # Create symlink
  mkdir -p "$HOME/.local/bin"
  ln -sf "$INSTALL_DIR/daemon/bin/companion" "$HOME/.local/bin/companion"

  # Add to PATH if needed
  if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
    echo -e "${YELLOW}Add to your shell profile:${NC}"
    echo '  export PATH="$HOME/.local/bin:$PATH"'
    echo ""
  fi

  echo -e "${GREEN}✓${NC} Installed to $INSTALL_DIR"
}

# Generate config and token
setup_config() {
  CONFIG_DIR="$HOME/.companion"
  CONFIG_FILE="$CONFIG_DIR/config.json"

  mkdir -p "$CONFIG_DIR"

  if [[ -f "$CONFIG_FILE" ]]; then
    echo -e "${GREEN}✓${NC} Config exists, preserving"
    TOKEN=$(grep -o '"token": *"[^"]*"' "$CONFIG_FILE" 2>/dev/null | cut -d'"' -f4 || echo "")
    return
  fi

  # Generate token
  if command -v openssl &>/dev/null; then
    TOKEN=$(openssl rand -hex 16)
  else
    TOKEN=$(head -c 32 /dev/urandom | xxd -p | head -c 32)
  fi

  cat > "$CONFIG_FILE" << EOF
{
  "port": 9877,
  "token": "$TOKEN",
  "tls": false,
  "tmux_session": "main",
  "code_home": "$HOME/.claude",
  "mdns_enabled": true,
  "push_delay_ms": 60000
}
EOF

  echo -e "${GREEN}✓${NC} Config created at $CONFIG_FILE"
}

# Setup systemd service (Linux) or launchd (macOS)
setup_service() {
  if [[ "$OSTYPE" == "darwin"* ]]; then
    setup_launchd
  else
    setup_systemd
  fi
}

setup_systemd() {
  SERVICE_DIR="$HOME/.config/systemd/user"
  SERVICE_FILE="$SERVICE_DIR/companion.service"

  mkdir -p "$SERVICE_DIR"

  # Find the companion binary
  if command -v companion &>/dev/null; then
    COMPANION_BIN=$(which companion)
  elif [[ -x "$HOME/.local/bin/companion" ]]; then
    COMPANION_BIN="$HOME/.local/bin/companion"
  elif [[ -x "$HOME/.companion/daemon/bin/companion" ]]; then
    COMPANION_BIN="$HOME/.companion/daemon/bin/companion"
  else
    echo -e "${YELLOW}Could not find companion binary, skipping service setup${NC}"
    return
  fi

  NODE_BIN=$(which node)

  cat > "$SERVICE_FILE" << EOF
[Unit]
Description=Companion Daemon
After=network.target

[Service]
Type=simple
ExecStart=$NODE_BIN $HOME/.companion/daemon/dist/index.js
Restart=always
RestartSec=5
Environment=HOME=$HOME
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload 2>/dev/null || true
  systemctl --user enable companion 2>/dev/null || true
  systemctl --user start companion 2>/dev/null || true

  if systemctl --user is-active companion &>/dev/null; then
    echo -e "${GREEN}✓${NC} Daemon started and enabled"
  else
    echo -e "${YELLOW}Service created but not started (may need relogin)${NC}"
  fi
}

setup_launchd() {
  PLIST_DIR="$HOME/Library/LaunchAgents"
  PLIST_FILE="$PLIST_DIR/com.companion.daemon.plist"

  mkdir -p "$PLIST_DIR"

  NODE_BIN=$(which node)
  DAEMON_SCRIPT="$HOME/.companion/daemon/dist/index.js"

  cat > "$PLIST_FILE" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.companion.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$DAEMON_SCRIPT</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>$HOME</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$HOME/Library/Logs/companion.log</string>
    <key>StandardErrorPath</key>
    <string>$HOME/Library/Logs/companion.error.log</string>
</dict>
</plist>
EOF

  launchctl unload "$PLIST_FILE" 2>/dev/null || true
  launchctl load "$PLIST_FILE" 2>/dev/null || true

  echo -e "${GREEN}✓${NC} LaunchAgent configured"
}

# Print success message
print_success() {
  echo ""
  echo -e "${GREEN}${BOLD}════════════════════════════════════════${NC}"
  echo -e "${GREEN}${BOLD}  Installation complete!${NC}"
  echo -e "${GREEN}${BOLD}════════════════════════════════════════${NC}"
  echo ""
  echo -e "${BOLD}Your authentication token:${NC}"
  echo -e "  ${YELLOW}$TOKEN${NC}"
  echo ""
  echo "Enter this in the Companion app to connect."
  echo ""
  echo -e "${BOLD}Quick commands:${NC}"
  echo "  companion status     Check if daemon is running"
  echo "  companion logs       View daemon logs"
  echo "  companion restart    Restart the daemon"
  echo "  companion config     View configuration"
  echo "  companion token      Generate new token"
  echo ""
  echo -e "${BOLD}Config file:${NC} ~/.companion/config.json"
  echo -e "${BOLD}Web client:${NC}  http://localhost:9877/web"
  echo ""
}

# Main
main() {
  check_deps
  install_git
  setup_config
  setup_service
  print_success
}

main "$@"
