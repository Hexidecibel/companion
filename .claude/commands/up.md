# Start Companion Services

Start the daemon and Expo dev server with cache cleared.

## Steps

1. Kill any existing processes:
```bash
pkill -f "node.*dist/index" 2>/dev/null; pkill -f "expo start" 2>/dev/null; pkill -f "metro" 2>/dev/null; sleep 1
```

2. Build the web client:
```bash
cd /Users/chriscushman/local/src/claude-companion/web && npm run build
```

3. Build and start the daemon:
```bash
cd /Users/chriscushman/local/src/claude-companion/daemon && npm run build && CONFIG_PATH=/Users/chriscushman/.companion/config.json nohup node dist/index.js > /tmp/daemon.log 2>&1 &
```

4. Start Expo with cache cleared on port 9009:
```bash
cd /Users/chriscushman/local/src/claude-companion/app && npx expo start --clear --port 9009
```

Run all commands in sequence. The web client builds to `web/dist/`, the daemon serves it at `/web`, and Expo runs in foreground on port 9009 with cache cleared.
