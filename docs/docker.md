# Companion with Docker

Run your own Companion server with Docker Compose. Your phone and laptops pair with it, and you watch and answer your Claude Code sessions from anywhere.

**You need:** Docker with Compose v2 (`docker compose version`). On Linux that is Docker Engine; on Mac or Windows it is Docker Desktop. You also need a Claude account (or an API key) for Claude Code.

## First run

```bash
git clone https://github.com/hexidecibel/companion.git
cd companion
cp .env.example .env
```

Edit `.env`:

- `COMPANION_PROJECTS=/home/you/code`: the folder with your projects. Sessions can only work inside it.
- `PUID` / `PGID`: the output of `id -u` and `id -g`. Files that Claude creates in your projects will then belong to you.

Start it:

```bash
docker compose up -d          # or: bin/docker up
```

This pulls `ghcr.io/hexidecibel/companion:latest`, which is built for amd64 and arm64.

1. **Open the web app:** `http://localhost:9877/web/`, or `http://<this machine's IP>:9877/web/` from another device.
2. **Pair this browser:** choose **Pair with a code**. The 6-digit code appears in the server log:
   ```bash
   bin/docker pair-code          # or: docker compose logs companion
   ```
   Every device pairs with a code, including the browser on the server itself. Docker's port mapping hides that it is the same machine. The code is valid for 2 minutes. Each device gets its own key, which you can revoke in Settings, Devices.
3. **Follow the wizard.** In the **Claude Code** step, click **Install Claude Code**. Or run it from a terminal:
   ```bash
   docker compose run --rm companion setup-claude
   ```
   Claude Code is not part of the image. It installs into a volume, so it survives restarts and image upgrades, and it keeps updating itself.
4. **Sign in to Claude Code once:**
   ```bash
   docker compose exec companion claude      # then type /login and follow the link
   ```
   Exit with `/exit` when you are done. The login is kept in the `claude` volume.
5. **Pair your phone.** Go to Settings, Devices, Show pairing QR, and scan it with the app. Or use **Pair by address** with this machine's IP and port 9877, then enter the code from `bin/docker pair-code`.

**Getting the apps:** the wizard's **Your devices** step links the Android APK and the desktop builds. They come from the public Companion feed (`COMPANION_APP_FEED_URL`, default `https://dev.cush.rocks/updates/stable/`). The installed apps update themselves from that feed. Set `COMPANION_APP_FEED_URL=` (empty) in `.env` to turn the lookup off. You can always use the web app instead.

## Everyday commands

`bin/docker` wraps plain `docker compose` commands:

| Command | What it does |
|---|---|
| `bin/docker up` / `down` | Start (pulling or building as needed) / stop. Volumes are kept. |
| `bin/docker logs` | Follow the server log |
| `bin/docker pair-code` | The latest pairing code |
| `bin/docker status` | Containers, health and `/health` |
| `bin/docker claude` | Claude Code inside the container |
| `bin/docker concierge [check]` | Start the concierge session, or check its prerequisites |
| `bin/docker exec CMD` | Run a command in the container, as the companion user |
| `bin/docker shell` | A shell inside the container, as the companion user |
| `bin/docker setup-claude` | Install or upgrade Claude Code |
| `bin/docker update` | Pull the newest image and recreate |
| `bin/docker restart` | Restart the server (some settings apply only after a restart) |
| `bin/docker backup` / `restore FILE` | Archive or restore the state volumes |
| `bin/docker build [--multi]` | Build the image yourself instead of pulling it |

Sessions run in tmux inside the container. To watch one in your terminal:

```bash
docker compose exec companion tmux ls
docker compose exec companion tmux attach -t <session>
```

`docker compose exec companion claude|tmux|companion` always runs as the companion user. A wrapper takes care of it.

## Volumes

| Volume | Mounted at | Holds |
|---|---|---|
| `claude` | `/home/companion/.claude` | Claude Code login, settings and conversation transcripts |
| `companion` | `/home/companion/.companion` | Server config, paired devices, `secrets.env`, review and Herald state |
| `local` | `/home/companion/.local` | The Claude Code install |
| (bind) `COMPANION_PROJECTS` | `/home/companion/projects` | Your code |
| `voice-models` | `/models` (voice service) | Voice models, about 500 MB (re-downloadable) |
| `tailscale-state` | (tailscale sidecar) | The sidecar's tailnet identity |

**Optional, for `git push` over SSH from sessions.** Uncomment these lines in `docker-compose.yml` (both are mounted read-only):

```yaml
- ~/.ssh:/home/companion/.ssh:ro
- ~/.gitconfig:/home/companion/.gitconfig:ro
```

## Upgrading

```bash
git pull               # newer compose file and docs
bin/docker update      # docker compose pull && docker compose up -d
```

Your config, devices, login and Claude Code install live in volumes, so recreating the container keeps them. Images are tagged `latest` and `1.0.<build>`. To stay on one build, set `COMPANION_IMAGE=ghcr.io/hexidecibel/companion:1.0.NNN` in `.env`.

## Backups

Back up the `companion` volume (devices, config, secrets) and the `claude` volume (login, transcripts). The `local` volume only holds the Claude Code install, which `setup-claude` can recreate. The voice models download again on their own.

```bash
bin/docker backup              # writes ./backups/companion-backup-<date>.tar.gz
bin/docker restore backups/companion-backup-<date>.tar.gz
```

The archive contains your device keys and secrets. Keep it private.

## Secrets (`secrets.env`)

There are two ways to give Companion secrets, such as `ANTHROPIC_API_KEY` for Herald:

- **The wizard** (Herald step): it saves them to `/home/companion/.companion/secrets.env` inside the `companion` volume, with mode 0600.
- **A file next to the compose file:** create `./secrets.env` with `KEY=value` lines. Compose passes it in as environment variables, which take precedence over the volume's file. It is ignored by git.

The images contain no secrets. You don't need cush-tools or Infisical.

## Remote access with Tailscale (optional)

The `tailscale` profile runs Tailscale's official image next to Companion. It gives the server a private HTTPS address that only your tailnet devices can reach:

1. In the Tailscale admin console, enable **MagicDNS** and **HTTPS certificates** (DNS page).
2. Create an auth key (Settings, Keys) and put it in `.env`:
   ```
   TS_AUTHKEY=tskey-auth-...
   TS_HOSTNAME=companion
   ```
3. Start it: `docker compose --profile tailscale up -d`. To always include it, set `COMPOSE_PROFILES=tailscale` in `.env`.

The address is **`https://companion.<your-tailnet>.ts.net/web/`**. `tailscale serve` handles HTTPS on port 443 and forwards to Companion. HTTPS also lets browsers use the microphone for Herald. The wizard's **Remote access** step and the machine check show whether the sidecar is connected. The sidecar runs in userspace mode and needs no extra privileges. Its identity is kept in the `tailscale-state` volume.

## Nearby discovery (host networking, Linux only)

Phones find servers on the same Wi-Fi with mDNS. Multicast does not cross Docker's default bridge network, so discovery is off there. On Linux you can run Companion on the host network instead. Add this to `.env`:

```
COMPOSE_FILE=docker-compose.yml:docker-compose.host.yml
```

Then run `docker compose up -d`. Companion now listens directly on the host, on `COMPANION_PORT`. That port is read on the **first** start only; after that it lives in the config in the `companion` volume. With host networking the browser on the server itself can pair without a code. The tailscale profile does not combine with host networking: install Tailscale on the host instead.

**Docker Desktop (Mac/Windows)** has no host networking, so discovery cannot work there. Pair with the QR code (Settings, Devices, Show pairing QR) or with **Pair by address**.

## Herald voice (optional)

Herald's local voice service (Kokoro text-to-speech, faster-whisper speech-to-text, the "hey jarvis" wake word) runs on the CPU in its own container:

```bash
docker compose --profile voice up -d
```

The image is about 750 MB. The first start downloads about 500 MB of models into the `voice-models` volume. It runs at nice 10 with the same thread caps as a host install (`HERALD_TTS_THREADS=6`, `HERALD_STT_THREADS=4`; change them in `.env`). Only the companion container talks to it: no port is published, and it has no auth of its own. The wizard's Herald step shows when it answers.

## Concierge (optional)

The concierge is a Claude session that routes your requests to your other project sessions, on this server or on other Companion servers. It is in the image: the companion-remote MCP server is at `/app/mcp`, and its folder is a copy in the `companion` volume (`/home/companion/.companion/concierge`). It needs Claude Code installed and signed in (above) and the **dispatch** capability, which is off by default:

```bash
docker compose exec companion companion enable-remote --enable dispatch
bin/docker restart
bin/docker concierge check      # claude, the concierge folder and the MCP server
```

Then open it from the app (the concierge button on the dashboard) or run `bin/docker concierge`. Edit `projects.json` in that folder (`bin/docker shell`) so each project's `cwd` points at its folder under `/home/companion/projects`. The routing rules (`CLAUDE.md`) follow the image on every start. The first time, Claude asks you to trust the folder and accept bypass-permissions mode: `docker compose exec companion tmux attach -t concierge`, accept, then detach with Ctrl-b d.

## Troubleshooting

**Files in my projects belong to the wrong user / permission denied.** Set `PUID`/`PGID` in `.env` to `id -u`/`id -g` and run `docker compose up -d`. On start the container re-owns its own volumes when the ids change. Your projects folder is never re-owned. `PUID=0` (root) is refused because Claude Code will not run sessions in bypass-permissions mode as root.

**A session I started with `tmux` does not show up.** Use `docker compose exec companion tmux ...`, which runs as the companion user. Every tmux server in the image tags its sessions with `COMPANION_APP=1`, which the server watches for. A tmux running on your host is a different tmux. Companion only sees sessions inside the container.

**Claude Code says it is not installed.** Run `docker compose run --rm companion setup-claude`, or use the button in the wizard. The install lives in the `local` volume. If you removed that volume, install it again.

**Claude Code asks me to log in again.** The login is in the `claude` volume (`CLAUDE_CONFIG_DIR=/home/companion/.claude`). Check that the volume still exists (`docker volume ls`). Then run `docker compose exec companion claude` and `/login`.

**A session shows "Do you trust the files in this folder?"** Sessions started from Companion run in bypass-permissions mode. Accept the prompt once per folder: `docker compose exec companion tmux attach -t <session>` and choose "Yes, I accept".

**No pairing code in the log.** Codes appear only after a device asks for one (Pair with a code). Run `bin/docker pair-code` right after. Pairing by code works from your local network and your tailnet. From anywhere else, use the QR code.

**The phone does not find the server under Nearby.** That is expected on the default bridge network. Use the QR code, or use host networking (above) on Linux.

**Health.** `curl http://localhost:9877/health` answers `{"ok":true,"version":"1.0.NNN","setupComplete":true}`. The version is the image's build number, the same `1.0.<commits>` scheme as the apps and host installs. Docker's healthcheck uses the same endpoint (`docker compose ps` shows `healthy`).

**What is not in the image.** Claude Code itself (it installs into the `local` volume) and the native app builds. Native apps come from the public feed.
