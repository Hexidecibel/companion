#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}"
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║         Companion Daemon Installer                            ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Detect OS
detect_os() {
  if [[ "$OSTYPE" == "darwin"* ]]; then
    OS="macos"
    PACKAGE_MANAGER="brew"
  elif [[ -f /etc/debian_version ]]; then
    OS="debian"
    PACKAGE_MANAGER="apt"
  elif [[ -f /etc/redhat-release ]]; then
    OS="redhat"
    PACKAGE_MANAGER="dnf"
    # Fall back to yum for older systems
    if ! command -v dnf &> /dev/null; then
      PACKAGE_MANAGER="yum"
    fi
  elif [[ -f /etc/arch-release ]]; then
    OS="arch"
    PACKAGE_MANAGER="pacman"
  elif [[ -f /etc/alpine-release ]]; then
    OS="alpine"
    PACKAGE_MANAGER="apk"
  else
    OS="unknown"
    PACKAGE_MANAGER="unknown"
  fi
  echo -e "${GREEN}Detected OS:${NC} $OS ($PACKAGE_MANAGER)"
}

# Check if running as root/sudo (not needed on macOS for user install)
check_permissions() {
  if [[ "$OS" == "macos" ]]; then
    # macOS: running as user is fine for user-level install
    ACTUAL_USER="$USER"
    ACTUAL_HOME="$HOME"
    INSTALL_DIR="$HOME/.companion"
    CONFIG_DIR="$HOME/.companion"
    NEEDS_SUDO=false
  else
    # Linux: prefer system-wide install with sudo
    if [ "$EUID" -ne 0 ]; then
      echo -e "${YELLOW}Running without sudo - will install to user directory${NC}"
      ACTUAL_USER="$USER"
      ACTUAL_HOME="$HOME"
      INSTALL_DIR="$HOME/.companion"
      CONFIG_DIR="$HOME/.companion"
      NEEDS_SUDO=false
    else
      ACTUAL_USER="${SUDO_USER:-$USER}"
      ACTUAL_HOME=$(eval echo "~$ACTUAL_USER")
      INSTALL_DIR="/opt/companion"
      CONFIG_DIR="/etc/companion"
      NEEDS_SUDO=true
    fi
  fi

  echo -e "${GREEN}Installing for user:${NC} $ACTUAL_USER"
  echo -e "${GREEN}Install directory:${NC} $INSTALL_DIR"
  echo -e "${GREEN}Config directory:${NC} $CONFIG_DIR"
  echo ""
}

# Install system dependencies
install_dependencies() {
  echo -e "${BLUE}Checking dependencies...${NC}"

  local DEPS_TO_INSTALL=()

  # Check Node.js
  if ! command -v node &> /dev/null; then
    DEPS_TO_INSTALL+=("nodejs")
  else
    NODE_VERSION=$(node -v)
    echo -e "  ${GREEN}✓${NC} Node.js $NODE_VERSION"
  fi

  # Check npm
  if ! command -v npm &> /dev/null; then
    DEPS_TO_INSTALL+=("npm")
  else
    NPM_VERSION=$(npm -v)
    echo -e "  ${GREEN}✓${NC} npm $NPM_VERSION"
  fi

  # Check tmux
  if ! command -v tmux &> /dev/null; then
    DEPS_TO_INSTALL+=("tmux")
  else
    TMUX_VERSION=$(tmux -V)
    echo -e "  ${GREEN}✓${NC} $TMUX_VERSION"
  fi

  # Check git (needed for clone)
  if ! command -v git &> /dev/null; then
    DEPS_TO_INSTALL+=("git")
  else
    echo -e "  ${GREEN}✓${NC} git $(git --version | cut -d' ' -f3)"
  fi

  # Check openssl (for token generation)
  if ! command -v openssl &> /dev/null; then
    DEPS_TO_INSTALL+=("openssl")
  else
    echo -e "  ${GREEN}✓${NC} openssl"
  fi

  if [ ${#DEPS_TO_INSTALL[@]} -eq 0 ]; then
    echo -e "${GREEN}All dependencies satisfied!${NC}"
    return 0
  fi

  echo ""
  echo -e "${YELLOW}Installing missing dependencies: ${DEPS_TO_INSTALL[*]}${NC}"

  case "$PACKAGE_MANAGER" in
    brew)
      # macOS with Homebrew
      if ! command -v brew &> /dev/null; then
        echo -e "${YELLOW}Homebrew not found. Installing Homebrew...${NC}"
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
      fi
      for dep in "${DEPS_TO_INSTALL[@]}"; do
        case "$dep" in
          nodejs) brew install node ;;
          npm) ;; # Comes with node
          *) brew install "$dep" ;;
        esac
      done
      ;;
    apt)
      # Debian/Ubuntu
      if $NEEDS_SUDO; then
        apt-get update
        for dep in "${DEPS_TO_INSTALL[@]}"; do
          case "$dep" in
            nodejs)
              # Use NodeSource for newer Node.js
              curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
              apt-get install -y nodejs
              ;;
            npm) ;; # Comes with nodejs from NodeSource
            *) apt-get install -y "$dep" ;;
          esac
        done
      else
        echo -e "${RED}Cannot install system packages without sudo.${NC}"
        echo "Please install manually: sudo apt install ${DEPS_TO_INSTALL[*]}"
        exit 1
      fi
      ;;
    dnf|yum)
      # RHEL/CentOS/Fedora
      if $NEEDS_SUDO; then
        for dep in "${DEPS_TO_INSTALL[@]}"; do
          case "$dep" in
            nodejs)
              curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
              $PACKAGE_MANAGER install -y nodejs
              ;;
            npm) ;; # Comes with nodejs
            *) $PACKAGE_MANAGER install -y "$dep" ;;
          esac
        done
      else
        echo -e "${RED}Cannot install system packages without sudo.${NC}"
        echo "Please install manually: sudo $PACKAGE_MANAGER install ${DEPS_TO_INSTALL[*]}"
        exit 1
      fi
      ;;
    pacman)
      # Arch Linux
      if $NEEDS_SUDO; then
        pacman -Sy --noconfirm "${DEPS_TO_INSTALL[@]}"
      else
        echo -e "${RED}Cannot install system packages without sudo.${NC}"
        echo "Please install manually: sudo pacman -S ${DEPS_TO_INSTALL[*]}"
        exit 1
      fi
      ;;
    apk)
      # Alpine
      if $NEEDS_SUDO; then
        apk add --no-cache "${DEPS_TO_INSTALL[@]}"
      else
        echo -e "${RED}Cannot install system packages without sudo.${NC}"
        echo "Please install manually: sudo apk add ${DEPS_TO_INSTALL[*]}"
        exit 1
      fi
      ;;
    *)
      echo -e "${RED}Unknown package manager. Please install manually:${NC}"
      echo "  - Node.js 18+ (https://nodejs.org)"
      echo "  - tmux"
      echo "  - git"
      echo "  - openssl"
      exit 1
      ;;
  esac

  echo -e "${GREEN}Dependencies installed!${NC}"
}

# Find or download the source code
setup_source() {
  echo ""
  echo -e "${BLUE}Setting up source code...${NC}"

  # Check if we're already in the daemon directory
  if [[ -f "./package.json" ]] && grep -q "companion-daemon" "./package.json" 2>/dev/null; then
    SOURCE_DIR="$(pwd)"
    echo -e "  ${GREEN}✓${NC} Using current directory: $SOURCE_DIR"
  elif [[ -f "../daemon/package.json" ]] && grep -q "companion-daemon" "../daemon/package.json" 2>/dev/null; then
    SOURCE_DIR="$(cd ../daemon && pwd)"
    echo -e "  ${GREEN}✓${NC} Using parent daemon directory: $SOURCE_DIR"
  else
    # Need to clone
    echo -e "  ${YELLOW}Source not found locally. Cloning repository...${NC}"
    TEMP_DIR=$(mktemp -d)
    git clone --depth 1 https://github.com/Hexidecibel/companion.git "$TEMP_DIR/companion"
    SOURCE_DIR="$TEMP_DIR/companion/daemon"
    CLEANUP_TEMP=true
  fi

  cd "$SOURCE_DIR"
}

# Build the daemon
build_daemon() {
  echo ""
  echo -e "${BLUE}Building daemon...${NC}"

  cd "$SOURCE_DIR"

  # Check if already built
  if [[ -f "./dist/index.js" ]]; then
    echo -e "  ${GREEN}✓${NC} Build already exists"

    # Check if source is newer than build
    if [[ "./src/index.ts" -nt "./dist/index.js" ]]; then
      echo -e "  ${YELLOW}Source is newer than build, rebuilding...${NC}"
      npm install
      npm run build
    fi
  else
    echo -e "  Installing npm dependencies..."
    npm install

    echo -e "  Compiling TypeScript..."
    npm run build
  fi

  if [[ ! -f "./dist/index.js" ]]; then
    echo -e "${RED}Build failed! dist/index.js not found${NC}"
    exit 1
  fi

  echo -e "  ${GREEN}✓${NC} Build complete"
}

# Install to target directory
install_files() {
  echo ""
  echo -e "${BLUE}Installing files...${NC}"

  # Create directories
  mkdir -p "$INSTALL_DIR"
  mkdir -p "$CONFIG_DIR"
  mkdir -p "$CONFIG_DIR/certs"
  chmod 700 "$CONFIG_DIR/certs"

  # Copy files
  cp -r "$SOURCE_DIR/dist" "$INSTALL_DIR/"
  cp "$SOURCE_DIR/package.json" "$INSTALL_DIR/"
  cp "$SOURCE_DIR/package-lock.json" "$INSTALL_DIR/" 2>/dev/null || true

  # Install production dependencies
  cd "$INSTALL_DIR"
  npm install --production --silent

  echo -e "  ${GREEN}✓${NC} Files installed to $INSTALL_DIR"
}

# Generate or preserve config
setup_config() {
  echo ""
  echo -e "${BLUE}Setting up configuration...${NC}"

  CONFIG_FILE="$CONFIG_DIR/config.json"

  if [[ -f "$CONFIG_FILE" ]]; then
    echo -e "  ${GREEN}✓${NC} Config file already exists"
    TOKEN=$(grep -o '"token": *"[^"]*"' "$CONFIG_FILE" | cut -d'"' -f4)
  else
    # Generate new token
    TOKEN=$(openssl rand -hex 32)

    cat << EOF > "$CONFIG_FILE"
{
  "port": 9877,
  "token": "$TOKEN",
  "tls": true,
  "cert_path": "$CONFIG_DIR/certs/cert.pem",
  "key_path": "$CONFIG_DIR/certs/key.pem",
  "tmux_session": "companion",
  "code_home": "$ACTUAL_HOME/.claude",
  "mdns_enabled": true,
  "push_delay_ms": 60000
}
EOF

    echo -e "  ${GREEN}✓${NC} Config file created"
  fi
}

# Setup service (systemd or launchd)
setup_service() {
  echo ""
  echo -e "${BLUE}Setting up service...${NC}"

  if [[ "$OS" == "macos" ]]; then
    setup_launchd
  else
    setup_systemd
  fi
}

# macOS launchd setup
setup_launchd() {
  PLIST_PATH="$HOME/Library/LaunchAgents/com.companion.daemon.plist"
  mkdir -p "$HOME/Library/LaunchAgents"

  cat << EOF > "$PLIST_PATH"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.companion.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>$INSTALL_DIR/dist/index.js</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>CONFIG_PATH</key>
        <string>$CONFIG_DIR/config.json</string>
        <key>NODE_ENV</key>
        <string>production</string>
    </dict>
    <key>WorkingDirectory</key>
    <string>$INSTALL_DIR</string>
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

  # Find node path
  NODE_PATH=$(which node)
  sed -i '' "s|/usr/local/bin/node|$NODE_PATH|g" "$PLIST_PATH"

  # Load the service
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  launchctl load "$PLIST_PATH"

  echo -e "  ${GREEN}✓${NC} LaunchAgent created and loaded"

  SERVICE_TYPE="launchd"
}

# Linux systemd setup
setup_systemd() {
  if ! command -v systemctl &> /dev/null; then
    echo -e "  ${YELLOW}systemd not found, skipping service setup${NC}"
    echo -e "  You can run manually: node $INSTALL_DIR/dist/index.js"
    SERVICE_TYPE="manual"
    return
  fi

  if $NEEDS_SUDO; then
    SERVICE_FILE="/etc/systemd/system/companion.service"
  else
    mkdir -p "$HOME/.config/systemd/user"
    SERVICE_FILE="$HOME/.config/systemd/user/companion.service"
  fi

  cat << EOF > "$SERVICE_FILE"
[Unit]
Description=Companion Daemon
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$(which node) $INSTALL_DIR/dist/index.js
Restart=always
RestartSec=5
Environment=CONFIG_PATH=$CONFIG_DIR/config.json
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
EOF

  if $NEEDS_SUDO; then
    systemctl daemon-reload
    systemctl enable companion
    systemctl start companion
    echo -e "  ${GREEN}✓${NC} Systemd service created (system-wide)"
  else
    systemctl --user daemon-reload
    systemctl --user enable companion
    systemctl --user start companion
    echo -e "  ${GREEN}✓${NC} Systemd service created (user-level)"
  fi

  SERVICE_TYPE="systemd"
}

# Verify installation
verify_installation() {
  echo ""
  echo -e "${BLUE}Verifying installation...${NC}"

  sleep 2

  # Check if process is running
  if pgrep -f "node.*companion" > /dev/null; then
    echo -e "  ${GREEN}✓${NC} Daemon is running"
  else
    echo -e "  ${RED}✗${NC} Daemon is not running"
    echo ""
    echo "Check logs:"
    if [[ "$OS" == "macos" ]]; then
      echo "  cat ~/Library/Logs/companion.log"
      echo "  cat ~/Library/Logs/companion.error.log"
    elif [[ "$SERVICE_TYPE" == "systemd" ]]; then
      if $NEEDS_SUDO; then
        echo "  sudo journalctl -u companion -e"
      else
        echo "  journalctl --user -u companion -e"
      fi
    fi
    return 1
  fi

  # Check if port is listening
  if command -v lsof &> /dev/null; then
    if lsof -i :9877 > /dev/null 2>&1; then
      echo -e "  ${GREEN}✓${NC} Listening on port 9877"
    fi
  elif command -v ss &> /dev/null; then
    if ss -tln | grep -q ":9877"; then
      echo -e "  ${GREEN}✓${NC} Listening on port 9877"
    fi
  fi

  return 0
}

# Print success message
print_success() {
  echo ""
  echo -e "${GREEN}"
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║         Installation Complete!                               ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo -e "${NC}"
  echo ""
  echo -e "${GREEN}Your authentication token:${NC}"
  echo -e "  ${YELLOW}$TOKEN${NC}"
  echo ""
  echo -e "${GREEN}Add this to your Companion mobile app.${NC}"
  echo ""
  echo -e "${BLUE}Service commands:${NC}"

  if [[ "$OS" == "macos" ]]; then
    echo "  View logs:     tail -f ~/Library/Logs/companion.log"
    echo "  Restart:       launchctl kickstart -k gui/\$(id -u)/com.companion.daemon"
    echo "  Stop:          launchctl unload ~/Library/LaunchAgents/com.companion.daemon.plist"
    echo "  Start:         launchctl load ~/Library/LaunchAgents/com.companion.daemon.plist"
  elif [[ "$SERVICE_TYPE" == "systemd" ]]; then
    if $NEEDS_SUDO; then
      echo "  View logs:     sudo journalctl -u companion -f"
      echo "  Restart:       sudo systemctl restart companion"
      echo "  Stop:          sudo systemctl stop companion"
      echo "  Status:        sudo systemctl status companion"
    else
      echo "  View logs:     journalctl --user -u companion -f"
      echo "  Restart:       systemctl --user restart companion"
      echo "  Stop:          systemctl --user stop companion"
      echo "  Status:        systemctl --user status companion"
    fi
  else
    echo "  Run manually:  CONFIG_PATH=$CONFIG_DIR/config.json node $INSTALL_DIR/dist/index.js"
  fi

  echo ""
  echo -e "${BLUE}Config file:${NC} $CONFIG_DIR/config.json"
  echo ""
  echo -e "${YELLOW}Next steps:${NC}"
  echo "  1. Make sure tmux is running: tmux new -s companion"
  echo "  2. Start your coding session in tmux"
  echo "  3. Connect from the mobile app using your token"
}

# Cleanup
cleanup() {
  if [[ "${CLEANUP_TEMP:-false}" == "true" ]] && [[ -n "${TEMP_DIR:-}" ]]; then
    rm -rf "$TEMP_DIR"
  fi
}

trap cleanup EXIT

# Main installation flow
main() {
  detect_os
  check_permissions
  install_dependencies
  setup_source
  build_daemon
  install_files
  setup_config
  setup_service

  if verify_installation; then
    print_success
  else
    echo ""
    echo -e "${YELLOW}Installation completed with warnings. Please check the logs.${NC}"
    echo -e "Token: ${YELLOW}$TOKEN${NC}"
  fi
}

main "$@"
