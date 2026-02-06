# Todo

Quick capture for ideas and tasks. Run `/plan` to process into detailed plans.

---

## Upcoming
- Desktop dashboard mode -- toggleable card-based dashboard view alongside current sidebar (for monitoring)
- iOS push notifications -- implement native APNs plugin for tauri-plugin-fcm (currently no-op on iOS, Android only)
- Escape key on mobile -- add virtual Esc key for mobile platforms
- Cancel button (all platforms) -- stop Claude mid-task so user can re-instruct
- Edit previously sent message -- allow editing a sent message while Claude is still working
- "Open in editor" button -- only show on host machine (not useful on mobile); fix file type associations (e.g. .tsx opening in Chrome instead of editor)
- Add server button styling -- make the add server button in sidebar full width underneath the server/session list (currently looks janky on web)
- Web hotkey for files -- keyboard shortcut to open file finder in browser
- Web hotkey for search -- keyboard shortcut to open search in browser
- Review auto-approve effectiveness -- currently sends "yes" in chat but unclear how much it helps vs Claude's per-project trust. Investigate whether the button is actually effective or if trust is built through repeated "accept all" in CLI
- Multi-choice prompt UX -- show prompts one at a time (not all at once), prevent out-of-order answers, add review/submit button like Claude CLI does
- Mobile app icons -- logos not displaying correctly on Android (Tauri vector override) and iOS; need proper icon pipeline for both platforms

## In Progress

## Done
- [done] Unify terminal and chat input
- [done] Add back button from session view to server dashboard
- [done] Replace archive/history with cross-session conversation search
- [done] Mac desktop app: file path links should open in file viewer
- [done] Parse task-notification XML messages properly and show a tool result card
- [done] Fix viewport overflow (100vh → 100dvh) for all screens
- [done] Fix safe area handling for skill browser and scrollable containers
- [done] Add back button to terminal panel on mobile
- [done] Mobile keyboard dismissal — tap conversation/terminal to dismiss
- [done] Mobile keyboard viewport adjustment via visualViewport API
- [done] Mobile terminal empty Enter to accept prompts

## Deferred
- OpenAI Codex CLI parser -- roadmap item, not prioritized
- macOS desktop polish -- global hotkey, deep links, code signing, auto-update
- Windows release -- Tauri cross-compiles, need CI/CD pipeline
- Make parallel worker agent spawning optional (sometimes might not make sense)
