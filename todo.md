# Todo

Quick capture for ideas and tasks. Run `/plan` to process into detailed plans.

---

## Upcoming
- BUG: a new session alone in its folder can display an older transcript via `ensureConversationLoaded`
- BUG: plain `codex` parks on an "Update available" screen that shows only in the terminal, so the app sees nothing to answer
- Flaky tests: `daemon` `ledger-codex.test.ts:189`; `daemon` `tracker.test.ts:520` (wall-clock slice limit, 51.37 vs 50 ms under full-suite load)
- Packaging follow-ups -- (1) "Get the apps" should link a proper signed/notarized macOS .dmg for friends, not the updater .app.tar.gz; (2) include Concierge in the Docker image; (3) /health reports version 1.0.0 on host installs vs 1.0.<n> in the image -- unify version source; (4) live-test with a friend: host-network mode (Nearby discovery), Tailscale sidecar joining a real tailnet, interactive /login in the container. See plan.md 'Packaging for friends & devs'
- Developer ID cert expires 2027-02-01 -- renew + re-run bin/desktop-signing import-devid before then
- Custom "Herald" wake word -- train an openWakeWord model overnight on this box from synthetic Kokoro/Piper "Herald"/"Hey Herald" clips + negatives (bin/ script), load via HERALD_WAKE_MODELS, add spellings to WAKE_NAMES; keep "hey jarvis" as fallback. See plan.md 'Voice Front Layer' [planned]
- Herald Phase 2 (desktop voice) -- push-to-talk + TTS; hide mic from Discord while PTT held (PipeWire, on by default); duck other audio while Herald speaks (lower/mute/off + level; phones via OS audio focus). See plan.md 'Voice Front Layer' [planned]
- Cmd+Alt+Tab session switcher -- keyboard shortcut to cycle between session windows (MRU order like Alt+Tab, hold modifiers + tap Tab to step, release to switch). Confirm target: desktop Tauri app vs browser; check OS doesn't swallow the combo
- Fleet initiative (Inbox -> Missions -> Routing -> Health) -- opt-in fleet/orchestration layer to differentiate from Anthropic Remote Control; Phase 1 Fleet Inbox is next. See plan.md 'Fleet (Inbox → Missions → Routing → Health)' [planned]
- [folded into Fleet Phase 2 -- Missions notes, see plan.md 'Fleet'] Server-level / session-persistent working memory -- across daemon rebuilds & restarts (and session compaction), Claude loses the live debugging context and re-derives or re-misdiagnoses the same problem. Want a durable "what we're mid-fixing + what we've already ruled out" store that survives. (Surfaced during the AUQ-render bug, which spun for multiple sessions partly from lost context.)
- Babysit fixes (f9be1ed, live 1.0.605, 2026-11-03) not yet seen working for real: confirm the next escalation shows Send/Cancel in the session's BabysitBar and that a plain "continue" gets answered. Run `herald-babysit-probe.js` (probe changed for the new danger scope + optional bar check, never run). Known gap: if the user answers in the terminal while background agents still run, the stale card stays until that work ends or the next prompt appears. Flaky web test: audio timing CPU budget (10.8% vs 10%) failed once in the full gate, passes alone
- Mission Control Phase 4: desktop grid (overview in main pane when nothing selected, sidebar "Overview" entry, 2x2..3x3 tiles with last ~4 highlights). See plan.md 'Mission Control' (plan: ~/.claude/plans/immutable-conjuring-lemon.md) [planned]
- Mission Control follow-up: ExitPlanMode "Approve" and batch-approve still answer positionally (index 0); resolve by on-screen label like send_choice selectedLabels
- Mission Control follow-up: pane-only AskUserQuestion prompts have unknown questionCount (multi-question flows may show answer buttons on the tile when they should say "Open to answer")
- Herald "<session> needs you" announcement for sessions not on screen + waiting-count badge on the app icon
- Mission Control: if tiles miss prompts while Herald is off, consider a defended capture of waiting panes (in-flight dedupe, timeout/SIGKILL, waiting sessions only)
- Flaky web test: `aecCore.test.ts` CPU-budget test fails under full-gate load
