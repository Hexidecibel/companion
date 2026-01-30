#!/bin/bash
set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}"
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║         Companion Daemon Uninstaller                          ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Detect OS
if [[ "$OSTYPE" == "darwin"* ]]; then
  OS="macos"
else
  OS="linux"
fi

# Confirm
echo -e "${YELLOW}This will remove Companion daemon.${NC}"
echo ""
read -p "Continue? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Cancelled."
  exit 0
fi

echo ""
echo -e "${BLUE}Stopping service...${NC}"

if [[ "$OS" == "macos" ]]; then
  # macOS: unload launchd
  PLIST_PATH="$HOME/Library/LaunchAgents/com.companion.daemon.plist"
  if [[ -f "$PLIST_PATH" ]]; then
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    rm -f "$PLIST_PATH"
    echo -e "  ${GREEN}✓${NC} LaunchAgent removed"
  fi
else
  # Linux: stop systemd
  if systemctl --user is-active companion &>/dev/null; then
    systemctl --user stop companion
    systemctl --user disable companion
    rm -f "$HOME/.config/systemd/user/companion.service"
    systemctl --user daemon-reload
    echo -e "  ${GREEN}✓${NC} User systemd service removed"
  elif systemctl is-active companion &>/dev/null 2>&1; then
    if [ "$EUID" -eq 0 ]; then
      systemctl stop companion
      systemctl disable companion
      rm -f /etc/systemd/system/companion.service
      systemctl daemon-reload
      echo -e "  ${GREEN}✓${NC} System systemd service removed"
    else
      echo -e "  ${YELLOW}System service found. Run with sudo to remove.${NC}"
    fi
  fi
fi

# Kill any running processes
pkill -f "node.*companion" 2>/dev/null || true

echo ""
echo -e "${BLUE}Removing files...${NC}"

# Remove install directories
DIRS_TO_CHECK=(
  "$HOME/.companion"
  "/opt/companion"
)

for dir in "${DIRS_TO_CHECK[@]}"; do
  if [[ -d "$dir" ]]; then
    rm -rf "$dir"
    echo -e "  ${GREEN}✓${NC} Removed $dir"
  fi
done

# Ask about config
echo ""
read -p "Remove configuration and certificates? (y/N) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  CONFIG_DIRS=(
    "$HOME/.companion"
    "/etc/companion"
  )
  for dir in "${CONFIG_DIRS[@]}"; do
    if [[ -d "$dir" ]]; then
      if [[ "$dir" == "/etc/companion" ]] && [ "$EUID" -ne 0 ]; then
        echo -e "  ${YELLOW}Cannot remove $dir without sudo${NC}"
      else
        rm -rf "$dir"
        echo -e "  ${GREEN}✓${NC} Removed $dir"
      fi
    fi
  done
fi

# Remove logs on macOS
if [[ "$OS" == "macos" ]]; then
  rm -f "$HOME/Library/Logs/companion.log" 2>/dev/null
  rm -f "$HOME/Library/Logs/companion.error.log" 2>/dev/null
fi

echo ""
echo -e "${GREEN}Companion daemon has been uninstalled.${NC}"
