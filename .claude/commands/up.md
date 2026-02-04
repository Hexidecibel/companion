# Start Companion Services

Build and start the daemon via systemd, and build the web client.

## Steps

1. Build the web client:
```bash
cd web && npm run build
```

2. Build the daemon:
```bash
cd daemon && npm run build
```

3. Restart the companion service:
```bash
systemctl --user restart companion
```

4. Verify the service is running:
```bash
systemctl --user status companion --no-pager
```

Run all commands in sequence. The web client builds to `web/dist/`, the daemon serves it at `/web`. The systemd service manages the daemon process.
