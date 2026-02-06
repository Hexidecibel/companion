# Start Project

Start your project's development services.

## Instructions

1. Detect the project type and services:
   - Check `package.json` scripts for `dev`, `start`, `serve`
   - Check for `docker-compose.yml` or `compose.yml`
   - Check for `Procfile` or `Procfile.dev`
   - Check for `Makefile` with `run` or `dev` targets
   - Check for framework-specific files (next.config.*, vite.config.*, etc.)
   - Check for systemd services related to the project

2. Build if needed:
   - Run the build command (e.g., `npm run build`, `cargo build`, `go build`)
   - Build multiple packages if monorepo

3. Start services in order:
   - Databases/infrastructure first (docker-compose up -d)
   - Then application server (npm run dev, systemctl restart, etc.)

4. Report what was started and on which ports

## Fault Detection

- If no start script found, ask what the project needs
- If a port is already in use, report it and suggest alternatives
- If dependencies aren't installed, run install first
