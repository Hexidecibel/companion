# Todo

Quick capture for ideas and tasks. Run `/plan` to process into detailed plans.

---

## App Store Release
- ~~Privacy policy~~ done -- PRIVACY.md written, needs hosting (GitHub Pages)
- Release signing key -- generate a proper upload key for Google Play (back it up!). Enroll in Google Play App Signing
- ~~Store listing content~~ done -- STORE-LISTING.md drafted (descriptions + keywords). Still need screenshots + feature graphic
- ~~Version bump to 1.0.0~~ done -- all packages synced
- iOS push notifications -- implement APNs in tauri-plugin-fcm (currently no-op stub) [planned]
- Auth screen store links -- add Google Play and App Store badges/links to the web first-auth screen
- Google Play developer registration -- $25 one-time, set up app listing
- TestFlight beta -- submit iOS build for beta testing before public release

## Upcoming
- Split snap layouts -- show snap zone boxes (like Windows/macOS) when dragging/splitting sessions into different configurations
- Theme customization -- choosable theme presets (sent message gradient, text color, button color, accents). Curated set of options, not too many
- Mobile button rearrange -- move on/off toggles (Notify, Auto, Tools) to header, move Files/Search/Terminal to bottom bar. Cancel stays in bottom
- New project wizard v2 -- reimplement bigger and better than before
- Copy/paste support -- better copy for messages (copy button, allow shortening/selecting before copy). Desktop text selection now works (fixed focus-stealing); mobile still needs work
- Skeleton loading screens -- animated placeholder cards while sessions/conversations load instead of spinners
- Expose hook error states in UI -- inline error banners for failed fetches (conversation, tasks, review diff). Currently errors are silent
- React.memo on MessageBubble and ToolCard -- prevent cascading re-renders in long conversations, especially on mobile
- Split websocket.ts into handler modules -- extract into ws-session-handlers, ws-file-handlers, ws-skill-handlers etc. Currently 3,891 lines
- Extract reusable usePollData hook -- 5 hooks duplicate identical 5000ms polling pattern, ~400 lines removable
- Vite code splitting -- lazy-load UsageDashboard, CodeReviewModal, FileViewerModal, ConversationSearch. Main bundle is 816KB
- Defensive JSONL parsing -- graceful fallbacks for unknown entry types and format changes. Claude's format isn't officially stable either
- Permission prompts stuck in chat mode -- parse "Yes / Yes and always allow / No" permission prompts from CLI output and surface them as tappable options (like AskUserQuestion). Currently no indication when stuck at these. (partially done: native key-sequence choice selection now works for JSONL-detected approval tools)
- Diff line number gutter [planned] -- render actual line numbers alongside diff lines in CodeReviewModal (data already computed for line comments)
- Sticky comment threads on files [planned] -- persist line comments in localStorage (session+file keyed) so previous comments show as annotations when reopening review modal
- Session activity sparkline [planned] -- tiny inline SVG in sidebar showing message frequency over last 30min (one bar per minute). Data available from highlights timestamps
- Batch approve pending tools [planned] -- "Approve all N" button when multiple tool calls pending, instead of individual approval. send_choice infra already handles key sequences
- Message bookmarks [planned] -- long-press/right-click to bookmark a message, stored in localStorage, accessible from header button
- Centralize localStorage keys into storageKeys.ts [planned] -- 38 scattered operations use hardcoded string keys, single module with typed key builders prevents typos
- Extract QuestionBlock and MultiQuestionFlow out of MessageBubble.tsx [planned] -- 808-line file with 3 complex sub-components inlined, move to own file (~300 lines)
- Named constants for daemon magic numbers [planned] -- hardcoded delays (150ms, 80ms, 200ms), size limits (5MB, 150MB), cache TTLs (30s) scattered across 4000 lines. Extract to daemon/src/constants.ts
- Focus-visible keyboard outlines [planned] -- no :focus-visible styles in global.css, keyboard users can't see focused button. Add consistent blue glow ring
- Error toast for failed choice/approval sends [planned] -- onSelectChoice failures swallowed silently, show inline "Failed to send — tap to retry" below options

