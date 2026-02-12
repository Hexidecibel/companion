# Todo

Quick capture for ideas and tasks. Run `/plan` to process into detailed plans.

---

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

