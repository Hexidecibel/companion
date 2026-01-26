#!/bin/bash
set -e

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║         Claude Companion Daemon Installer                    ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# Check for root/sudo
if [ "$EUID" -ne 0 ]; then
  echo "Please run with sudo: sudo bash install.sh"
  exit 1
fi

# Get the actual user (not root when running with sudo)
ACTUAL_USER="${SUDO_USER:-$USER}"
ACTUAL_HOME=$(eval echo "~$ACTUAL_USER")

echo "Installing for user: $ACTUAL_USER"
echo "Home directory: $ACTUAL_HOME"
echo ""

# Create directories
echo "Creating directories..."
mkdir -p /opt/claude-companion
mkdir -p /etc/claude-companion
mkdir -p /etc/claude-companion/certs
chmod 700 /etc/claude-companion/certs

# Check if Node.js is installed (for source install)
if command -v node &> /dev/null; then
  NODE_VERSION=$(node -v)
  echo "Node.js found: $NODE_VERSION"
else
  echo "Node.js not found. Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

# Download or copy daemon
if [ -f "./dist/index.js" ]; then
  echo "Using local build..."
  cp -r ./dist /opt/claude-companion/
  cp ./package.json /opt/claude-companion/
  cd /opt/claude-companion && npm install --production
else
  echo "Downloading daemon..."
  # For now, we'll assume local installation
  echo "Please build the daemon first: npm run build"
  echo "Then run this script from the daemon directory."
  exit 1
fi

# Generate authentication token
TOKEN=$(openssl rand -hex 32)

# Create config file if it doesn't exist
if [ ! -f /etc/claude-companion/config.json ]; then
  echo "Creating configuration..."
  cat << EOF > /etc/claude-companion/config.json
{
  "port": 9877,
  "token": "$TOKEN",
  "tls": true,
  "cert_path": "/etc/claude-companion/certs/cert.pem",
  "key_path": "/etc/claude-companion/certs/key.pem",
  "tmux_session": "claude",
  "claude_home": "$ACTUAL_HOME/.claude",
  "mdns_enabled": true,
  "push_delay_ms": 60000
}
EOF
  echo "Generated authentication token: $TOKEN"
  echo ""
  echo "IMPORTANT: Save this token! You'll need it to connect from the mobile app."
  echo ""
  echo "TLS is enabled by default. Certificates will be auto-generated on first start."
  echo ""
else
  echo "Config file already exists, keeping existing settings."
  TOKEN=$(grep -o '"token": *"[^"]*"' /etc/claude-companion/config.json | cut -d'"' -f4)
  echo "Existing token: $TOKEN"
fi

# Create systemd service
echo "Creating systemd service..."
cat << EOF > /etc/systemd/system/claude-companion.service
[Unit]
Description=Claude Companion Daemon
After=network.target

[Service]
Type=simple
User=$ACTUAL_USER
WorkingDirectory=/opt/claude-companion
ExecStart=/usr/bin/node /opt/claude-companion/dist/index.js
Restart=always
RestartSec=5
Environment=CONFIG_PATH=/etc/claude-companion/config.json
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

# Reload systemd and enable service
echo "Enabling and starting service..."
systemctl daemon-reload
systemctl enable claude-companion
systemctl start claude-companion

# Check status
sleep 2
if systemctl is-active --quiet claude-companion; then
  echo ""
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║         Installation Complete!                               ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""
  echo "Service status: $(systemctl is-active claude-companion)"
  echo "Listening on port: 9877"
  echo ""
  echo "Your authentication token:"
  echo "  $TOKEN"
  echo ""
  echo "Add this token to your Claude Companion mobile app."
  echo ""
  echo "Commands:"
  echo "  View logs:     sudo journalctl -u claude-companion -f"
  echo "  Restart:       sudo systemctl restart claude-companion"
  echo "  Stop:          sudo systemctl stop claude-companion"
  echo "  Edit config:   sudo nano /etc/claude-companion/config.json"
else
  echo "ERROR: Service failed to start. Check logs with:"
  echo "  sudo journalctl -u claude-companion -e"
  exit 1
fi
