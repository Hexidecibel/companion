# Stop Companion Services

Stop the daemon and Expo dev server.

## Steps

1. Kill the daemon process:
```bash
pkill -f "node.*companion-daemon" || true
```

2. Kill Expo processes:
```bash
pkill -f "expo start" || true
```

Run both commands to stop all services.
