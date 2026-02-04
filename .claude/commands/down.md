# Stop Companion Services

Stop the daemon via systemd.

## Steps

1. Stop the companion service:
```bash
systemctl --user stop companion
```

2. Verify it stopped:
```bash
systemctl --user status companion --no-pager
```
