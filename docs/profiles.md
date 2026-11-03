# Account profiles

Moved verbatim from `CLAUDE.md` (2026-11-03) to keep the auto-loaded context small.

### Account profiles (several Claude / Codex logins)
Config `profiles: [{id, label, agent: 'claude'|'codex', home, env?, env_file?}]`; the defaults `claude` (code_home) and `codex` (the Codex home) always exist and cannot be shadowed. Code: `daemon/src/profiles/` (registry re-reads config.json on mtime change from the watcher's 5 s refresh, so no restart; `protocol.ts` mirrored byte for byte by `web/src/types/profiles.ts`). A session's profile = `CLAUDE_CONFIG_DIR` / `CODEX_HOME` in its agent's `/proc/<pid>/environ` (else the pane shell's; cached per pid, no subprocess). Watcher path keys: default profile = bare encoded cwd (unchanged), others `profile:<id>:<encoded>`; Codex has a rollout index per profile home; chokidar gets one `projects/**/*.jsonl` pattern per extra Claude profile. Spawns: optional `profileId` (create_tmux_session, scaffold_open_session, Herald `propose_spawn_session` `profile`); the default Claude launch sets nothing (exactly as before); other profiles get the home var + `env` via `tmux -e`, and an env file (`env_file`, default `<config dir>/profiles/<id>.env`, 0600, KEY=VALUE, quote values with spaces) is sourced by the typed launch line (`sh -c 'set -a; . "$0"; set +a; exec "$@"' <file> claude ...`), never put in tmux's env, argv or logs. Requests `profiles_list` (login state from file presence only: `.credentials.json` / `auth.json`, else API-key variable names) and `profile_login` (tagged `login-<id>` session: `claude auth login` / `codex login --device-auth`; gated on `dispatch` for narrowed credentials); event `profiles_changed`. Mappings / snapshot stay under the default code_home with `profileId` recorded.

```bash
bin/companion profile list
bin/companion profile add work --agent claude [--label Work] [--home DIR] [--no-share]   # symlinks shared non-secret settings
bin/companion profile login work [--tmux]      # prints / starts the login (or Settings > Accounts > Log in)
bin/companion profile env-path work            # API keys go there (mode 600)
bin/companion profile remove work              # config entry only; the home stays
# Live test (probe + private tmux server; throwaway homes, no login, no credentials copied):
env -u TMUX -u TMUX_PANE node daemon/scripts/profile-probe.js --tmux-tmpdir $T
```

One-tap login (Settings > Accounts > Log in; `daemon/src/profiles/login-flow.ts` + pure `login-parser.ts`, web `components/ProfileLoginSheet.tsx`): the login runs in a hidden tmux session (no COMPANION_APP tag, so the watcher and start-up captures never see it; `COMPANION_LOGIN_FLOW=<home hash>.<nonce>` identifies it, kept out of every listing by `hideTmuxSession`); polled once a second only while active; only https links on `ALLOWED_LOGIN_HOSTS` pass; success = the login command's exit code 0 (recorded to `~/.companion/profile-login/<nonce>.exit` by the typed line), and success / failure / cancel / 15 min timeout all kill the session; leftovers of this home are reaped at start. Requests `profile_login_code` / `_cancel` / `_status`, event `profile_login_update` go only to clients allowed to dispatch. The link, device code and pasted code never reach logs, audit or errors (pasted text goes by `TmuxManager.sendSecretLine`, execFile, no logging).

```bash
# Live test (no real login; the real CLIs are only started and cancelled; fake logins via
# COMPANION_PROFILE_LOGIN_TEST_DIR, honoured only with COMPANION_SANDBOX=1):
T=/tmp/claude-1000/plgp; mkdir -p -m 700 $T $T/fake
env -u TMUX -u TMUX_PANE TMUX_TMPDIR=$T COMPANION_PROFILE_LOGIN_TEST_DIR=$T/fake bin/herald-sandbox --instance probe start
env -u TMUX -u TMUX_PANE node daemon/scripts/profile-login-probe.js --tmux-tmpdir $T
bin/herald-sandbox --instance probe stop; rm -rf $T
```
