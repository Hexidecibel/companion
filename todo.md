# Todo

Quick capture for ideas and tasks. Run `/plan` to process into detailed plans.

---

## App Store Release
- Release signing key -- generate a proper upload key for Google Play (back it up!). Enroll in Google Play App Signing
- iOS push notifications -- implement APNs in tauri-plugin-fcm (currently no-op stub) [planned]
- Auth screen store links -- add Google Play and App Store badges/links to the web first-auth screen
- Google Play developer registration -- $25 one-time, set up app listing
- TestFlight beta -- submit iOS build for beta testing before public release

## Upcoming
- Herald (voice front layer) -- Phase 1 text-only in progress on branch feat/herald (worktree ../companion-herald). See plan.md 'Voice Front Layer' [in-progress]
- Cmd+Alt+Tab session switcher -- keyboard shortcut to cycle between session windows (MRU order like Alt+Tab, hold modifiers + tap Tab to step, release to switch). Confirm target: desktop Tauri app vs browser; check OS doesn't swallow the combo
- Fleet initiative (Inbox -> Missions -> Routing -> Health) -- opt-in fleet/orchestration layer to differentiate from Anthropic Remote Control; Phase 1 Fleet Inbox is next. See plan.md 'Fleet (Inbox → Missions → Routing → Health)' [planned]
- BUG: App doesn't reconnect after daemon restart -- WS closes on daemon restart, client never re-establishes a working connection; `send` silently no-ops; only fix is remove server + re-add. Need auto-reconnect (backoff) that re-runs authenticate + subscribe, not just reopens the socket. (High pain -- this is what made every debug restart miserable.)
- [folded into Fleet Phase 2 -- Missions notes, see plan.md 'Fleet'] Server-level / session-persistent working memory -- across daemon rebuilds & restarts (and session compaction), Claude loses the live debugging context and re-derives or re-misdiagnoses the same problem. Want a durable "what we're mid-fixing + what we've already ruled out" store that survives. (Surfaced during the AUQ-render bug, which spun for multiple sessions partly from lost context.)
