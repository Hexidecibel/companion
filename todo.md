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
- BUG: App doesn't reconnect after daemon restart -- WS closes on daemon restart, client never re-establishes a working connection; `send` silently no-ops; only fix is remove server + re-add. Need auto-reconnect (backoff) that re-runs authenticate + subscribe, not just reopens the socket. (High pain -- this is what made every debug restart miserable.)
- Server-level / session-persistent working memory -- across daemon rebuilds & restarts (and session compaction), Claude loses the live debugging context and re-derives or re-misdiagnoses the same problem. Want a durable "what we're mid-fixing + what we've already ruled out" store that survives. (Surfaced during the AUQ-render bug, which spun for multiple sessions partly from lost context.)
