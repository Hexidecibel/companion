#!/bin/bash
# Install or upgrade Claude Code into ~/.local (a volume: survives container
# recreation and image upgrades). Never logs in.
#
#   CLAUDE_INSTALL_METHOD=native (default)  Anthropic's installer (claude.ai/install.sh);
#                                           Claude Code keeps itself updated afterwards.
#   CLAUDE_INSTALL_METHOD=npm               npm i -g @anthropic-ai/claude-code into ~/.local
#   --quiet                                 no closing hints (the setup wizard's button)
set -euo pipefail
exec 2>&1
quiet=0
[ "${1:-}" = "--quiet" ] && quiet=1
method="${CLAUDE_INSTALL_METHOD:-native}"
bin="$HOME/.local/bin/claude"
mkdir -p "$HOME/.local/bin"

if [ -x "$bin" ]; then
  echo "Claude Code is installed ($("$bin" --version 2>/dev/null | head -1 || echo '?')); upgrading..."
else
  echo "Installing Claude Code ($method)..."
fi

case "$method" in
  native)
    curl -fsSL https://claude.ai/install.sh | bash -s -- latest
    ;;
  npm)
    npm install -g --prefix "$HOME/.local" --no-audit --no-fund @anthropic-ai/claude-code@latest
    ;;
  *)
    echo "Unknown CLAUDE_INSTALL_METHOD=$method (native or npm)"; exit 2 ;;
esac

if ! "$bin" --version >/dev/null 2>&1; then
  echo "Claude Code did not install correctly ($bin does not run)."
  exit 1
fi
echo "Installed: $("$bin" --version | head -1)"

if [ "$quiet" = 0 ]; then
  cat <<'HINT'

Next: sign in once (the login is kept in the ~/.claude volume):

  docker compose exec companion claude      (then type /login and follow the link)

or start a session from the Companion web app and run /login there.
HINT
fi
