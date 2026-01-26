# Start Claude Companion Services

Start the daemon and Expo dev server.

## Steps

1. Build and start the daemon:
```bash
cd daemon && npm run build && npm run start &
```

2. Start Expo in the app directory:
```bash
cd app && npx expo start
```

Run both commands. The daemon runs in the background, Expo runs in foreground.
