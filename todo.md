# Todo

Quick capture for ideas and tasks. Run `/plan` to process into detailed plans.

---

## Upcoming
- iOS push notifications -- implement native APNs plugin for tauri-plugin-fcm (currently no-op on iOS, Android only)
- Edit previously sent message -- allow editing a sent message while Claude is still working
- "Open in editor" improvements -- fix file type associations (e.g. .tsx opening in Chrome instead of editor); only show button on host machine
- Add server button styling -- make the add server button in sidebar full width underneath the server/session list (currently looks janky on web)
- Review auto-approve effectiveness -- currently sends "yes" in chat but unclear how much it helps vs Claude's per-project trust
- Multi-choice prompt UX -- show prompts one at a time (not all at once), prevent out-of-order answers, add review/submit button like Claude CLI does
- Mobile app icons -- logos not displaying correctly on Android (Tauri vector override) and iOS; need proper icon pipeline for both platforms

## Deferred
- OpenAI Codex CLI parser -- roadmap item, not prioritized
- macOS desktop polish -- global hotkey, deep links, code signing, auto-update
- Windows release -- Tauri cross-compiles, need CI/CD pipeline
