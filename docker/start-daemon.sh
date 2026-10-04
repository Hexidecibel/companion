#!/bin/bash
# As the companion user: a tagged tmux server, then the daemon (PID 2 under tini).
set -euo pipefail
mkdir -p "$HOME/.companion" "$HOME/.claude" "$HOME/.local/bin"
chmod 700 "$HOME/.companion" "$HOME/.claude"

# The configured default session (falls back to "main" before the first config exists).
SESSION="$(node -e '
  try { const c = JSON.parse(require("fs").readFileSync(process.env.HOME + "/.companion/config.json", "utf8"));
        process.stdout.write(/^[A-Za-z0-9_-]+$/.test(c.tmux_session || "") ? c.tmux_session : "main"); }
  catch { process.stdout.write("main"); }')"

# /etc/tmux.conf sets COMPANION_APP=1 globally (the daemon only watches tagged
# sessions); set it again in case a server was already running.
if ! tmux has-session -t "=$SESSION" 2>/dev/null; then
  tmux new-session -d -s "$SESSION" -c "${COMPANION_PROJECTS_DIR:-$HOME}"
fi
tmux set-environment -g COMPANION_APP 1

if [ -x "$HOME/.local/bin/claude" ]; then
  echo "Claude Code: $("$HOME/.local/bin/claude" --version 2>/dev/null | head -1 || echo 'installed')"
else
  echo "Claude Code: not installed yet (docker compose run --rm companion setup-claude)"
fi

exec node /app/daemon/dist/index.js
