# Stop Project

Stop your project's running development services.

## Instructions

1. Detect running services:
   - Check for running docker-compose services
   - Check for node/python/go processes in the project directory
   - Check for systemd services related to the project
   - Check for processes on common dev ports (3000, 5173, 8080, etc.)

2. Stop services gracefully:
   - docker-compose down (if applicable)
   - systemctl stop (if applicable)
   - Send SIGTERM to application processes

3. Report what was stopped

## Fault Detection

- If no services found running, report that
- If a service won't stop, suggest force kill
