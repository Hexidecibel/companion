#!/bin/bash
# Companion container entrypoint (runs as root under tini, then drops to the
# "companion" user for everything else).
#
#   daemon          (default) tmux server + the Companion daemon
#   setup-claude    install / upgrade Claude Code into the ~/.local volume
#   shell           a login shell as the companion user
#   <cmd> [args]    any command, as the companion user
set -euo pipefail

H=/home/companion
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

if [ "$(id -u)" = "0" ]; then
  case "$PUID$PGID" in *[!0-9]*|"") echo "PUID/PGID must be numbers" >&2; exit 1 ;; esac
  if [ "$PUID" = "0" ]; then
    echo "PUID=0 is not supported: Claude Code refuses bypass-permissions mode as root." >&2
    exit 1
  fi
  # Remap the companion user to the host user so bind-mounted files keep sane ownership.
  [ "$(id -g companion)" = "$PGID" ] || groupmod -o -g "$PGID" companion
  [ "$(id -u companion)" = "$PUID" ] || usermod -o -u "$PUID" companion >/dev/null
  chown "$PUID:$PGID" "$H"
  # State volumes: fix ownership only when it is wrong (a PUID change or a fresh volume).
  for d in "$H/.claude" "$H/.companion" "$H/.local"; do
    mkdir -p "$d"
    if [ "$(stat -c %u:%g "$d")" != "$PUID:$PGID" ]; then
      echo "Fixing ownership of $d for $PUID:$PGID"
      chown -R "$PUID:$PGID" "$d"
    fi
  done
  chmod 700 "$H/.claude" "$H/.companion"
  # Projects: never chowned recursively (it is your code). Only a fresh,
  # empty folder Docker created as root is handed over.
  P="${COMPANION_PROJECTS_DIR:-$H/projects}"
  if [ -d "$P" ] && [ "$(stat -c %u "$P")" = "0" ] && [ -z "$(ls -A "$P" 2>/dev/null)" ]; then
    chown "$PUID:$PGID" "$P" 2>/dev/null || true
  fi
fi

cmd="${1:-daemon}"
[ $# -gt 0 ] && shift
case "$cmd" in
  daemon)       exec /app/docker/as-companion /app/docker/start-daemon.sh ;;
  setup-claude) exec /app/docker/as-companion /app/docker/setup-claude.sh "$@" ;;
  shell)        exec /app/docker/as-companion bash -l ;;
  *)            exec /app/docker/as-companion "$cmd" "$@" ;;
esac
