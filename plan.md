# Implementation Plan

Completed items have been moved to FEATURES.md.

---

## 20. Skill Browser/Installer + Slash Command Autocomplete
**Status:** done

Implemented skill scanner, catalog, WebSocket endpoints, slash command autocomplete in InputBar, and SkillBrowser page accessible from Settings. Steps 1-7 complete; Step 8 (prerequisites/fault detection) deferred to future work.

---

## Deferred

### OpenAI Codex CLI Parser
**Status:** deferred (roadmap)

Discover Codex conversation files, parse format, translate to internal types. Not prioritized — focusing on Claude Code integration first.

### macOS Desktop — Nice to Have
**Status:** deferred

Global hotkey (Ctrl+Shift+C), deep links (`companion://` URL scheme), CI build pipeline, code signing & notarization, auto-update via `tauri-plugin-updater`. Post-launch polish.
