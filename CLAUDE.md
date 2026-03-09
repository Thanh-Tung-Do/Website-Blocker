# Website Blocker — Chrome Extension (MV3)

## Repository
GitHub: https://github.com/Thanh-Tung-Do/Website-Blocker
Branch: `master`

## Current State (as of 2026-03-09)

The extension is at commit `82be4e7`, which is a revert back to the original
`0b5213f` codebase for `background.js`, `popup.html`, and `popup.js`.

### What is working
- **Blocking**: declarativeNetRequest with `regexFilter` rules, redirects to `blocked.html?site=DOMAIN`
- **Always-block toggle**: default ON (header pill), pure CSS (no `<input>` checkbox)
- **Schedule**: time-window + day-of-week blocking; saving requires password re-entry
- **Pomodoro**: work/break phases via `chrome.alarms`, badge W/B, notifications; stop requires confirm dialog
- **Master password**: SHA-256 via Web Crypto API, 5-attempt lockout (10 min), session unlock
- **Context menu**: "Block this website" right-click; handles locked/unlocked session
- **Blocked page**: inspirational quotes (35 built-in + custom), Pomodoro countdown, domain shown
- **Custom quotes**: add/remove from Settings tab

### Sites tab (current behaviour)
- Single flat `blocklist` array stored in `chrome.storage.local`
- Blocklist is **hidden by default** — user must click "Reveal Blocked Sites" and enter password
- After revealing: domains shown with ✕ remove buttons
- Adding a site does NOT require password (only viewing/removing does)

### Key files
| File | Purpose |
|------|---------|
| `manifest.json` | MV3 manifest, permissions, declarativeNetRequest |
| `background.js` | Service worker: blocking rules, Pomodoro, schedule, password, context menu |
| `popup.html` | Extension popup UI (4 tabs: Sites, Schedule, Pomodoro, Settings) |
| `popup.js` | Popup logic |
| `blocked.html` | Page shown when a site is blocked |
| `blocked.js` | Blocked-page logic (quotes, Pomodoro countdown) |
| `quotes.js` | 35 built-in inspirational quotes |
| `icons/` | icon16/48/128 PNG files (generated via Python zlib script) |

### Storage schema
- `chrome.storage.local`: `blocklist[]`, `schedule`, `pomodoroSettings`, `passwordHash`, `customQuotes`, `alwaysBlock`
- `chrome.storage.session`: `sessionUnlocked`, `failedAttempts`, `lockoutUntil`, `pomodoroRunning`, `pomodoroPhase`, `pomodoroEndTime`, `pomodoroSessionCount`, `pendingContextMenuDomain`

## Pending / Next Features
- **Custom multiple block lists**: user-created named lists, each independently togglable.
  The previous attempt (commit `e4a8f98`) had the right backend (`blockLists` structure,
  `getBlockLists()` migration, `effectiveDomains()`) but the popup UI was buggy.
  Needs a clean reimplementation starting from the current stable base.

## Known issues fixed in history
- Toggle double-fire: replaced `<input type="checkbox">` in the pill with pure CSS `.pill-track`/`.pill-thumb`
- Incognito quotes: `showBuiltInQuote()` runs synchronously; async upgrade has 1.5 s `Promise.race` timeout
- Popup state staleness: need `chrome.storage.onChanged` listener when re-adding multi-list feature

## Developer notes
- Node.js not available on this machine — use Python (`python -c "..."`) for any build scripts
- Always reload the unpacked extension in `chrome://extensions` after code changes
- Push to GitHub after every meaningful change set
