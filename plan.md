# Implementation Plan

Completed items have been moved to FEATURES.md.

---

## Item: Make parallel worker agent spawning optional
**Status:** planned

### Requirements
- Web UI toggle per-server (stored in localStorage) to disable parallel worker spawning
- When disabled, the daemon should reject `spawn_work_group` requests from that client
- Default: enabled (current behavior)
- Toggle visible in the session header or server settings area

### Files to Modify
- `web/src/services/storage.ts` — Add `parallelWorkersEnabled` per-server setting
- `web/src/hooks/useWorkGroups.ts` — Check setting before calling `spawn_work_group`; if disabled, show a notification/toast instead of spawning
- `web/src/components/SessionView.tsx` — Hide WorkGroupBar/WorkGroupPanel when disabled
- `web/src/components/Dashboard.tsx` — Pass setting through to SessionView
- `web/src/components/NotificationSettingsModal.tsx` (or new ServerSettingsModal) — Add toggle UI

### Implementation Steps
1. Add `parallelWorkersEnabled: boolean` to the server config in `storage.ts` (default: `true`)
2. Add a toggle in the notification/server settings modal: "Enable parallel workers"
3. In `useWorkGroups.ts`, wrap `spawn_work_group` calls: if setting is off, return early with an error/toast
4. In `SessionView.tsx`, conditionally render WorkGroupBar only when setting is enabled
5. The daemon doesn't need changes — it always supports work groups; the client just won't trigger them

### Edge Cases
- If workers are already running when user disables, keep showing them until complete
- Setting is per-server since different servers may have different needs

---

## Mobile Bug Fix Sprint — COMPLETED

All 6 items (viewport, safe areas, back buttons, keyboard dismissal, keyboard viewport, terminal Enter) are done.
See todo.md Done section for details.

---

## Deferred

### OpenAI Codex CLI Parser
**Status:** deferred (roadmap)

Discover Codex conversation files, parse format, translate to internal types. Not prioritized — focusing on Claude Code integration first.

### macOS Desktop — Nice to Have
**Status:** deferred

Global hotkey (Ctrl+Shift+C), deep links (`companion://` URL scheme), CI build pipeline, code signing & notarization, auto-update via `tauri-plugin-updater`. Post-launch polish.
