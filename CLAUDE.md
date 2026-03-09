# Website Blocker — Chrome Extension (MV3)

## Repository
GitHub: https://github.com/Thanh-Tung-Do/Website-Blocker
Branch: `master`

## Current State (as of 2026-03-10)

### What is working
- **Blocking**: declarativeNetRequest with `regexFilter` rules, redirects to `blocked.html?site=DOMAIN`
- **Always-block toggle**: default ON (header pill), pure CSS, instant CSS tooltip via `data-tooltip` + `::after`
- **Multiple schedules**: named schedule cards (enabled/disabled dot), add/edit/edit form; saving/deleting requires password
- **Pomodoro**: work/break phases via `chrome.alarms`, badge W/B, notifications; stop requires confirm dialog
- **Hard Mode**: timer-based lock (hours + minutes); overrides ALL other modes; persists across browser restarts via `chrome.storage.local`; `HM` badge on icon; cannot be stopped early
- **Master password**: PBKDF2 (200k iter) + AES-GCM encrypted blocklist, 5-attempt lockout (10 min), session unlock
- **Context menu**: right-click shows "Block this website" or "Unblock this website" based on current blocklist; updates dynamically on tab switch (`tabs` permission + `onActivated`/`onUpdated`)
- **Export / Import blocklist**: Export downloads `blocklist.txt`; Import uses paste-modal (file-picker approach dropped due to Chrome popup focus loss bug)
- **Blocked page**: 35 built-in quotes + custom quotes, Pomodoro countdown, domain shown
- **Custom quotes**: add/remove from Settings tab
- **Custom icon**: shield + closed padlock on purple gradient circle (Python-generated PNG, all 3 sizes)

### Sites tab
- Blocklist encrypted with AES-GCM; stored as `blocklistEncrypted` + `blocklistIV` in `chrome.storage.local`
- Hidden by default — "Reveal Blocked Sites" requires password
- After revealing: domains shown with ✕ remove buttons; "Hide list" button to re-hide
- Adding a site does NOT require password (only viewing/removing does)

### Key files
| File | Purpose |
|------|---------|
| `manifest.json` | MV3 manifest, permissions (includes `tabs`), declarativeNetRequest |
| `background.js` | Service worker: blocking rules, Pomodoro, schedule, Hard Mode, password, context menu |
| `popup.html` | Extension popup UI (5 tabs: Sites, Schedule, Pomodoro, Hard Mode, Settings) |
| `popup.js` | Popup logic |
| `blocked.html` | Page shown when a site is blocked |
| `blocked.js` | Blocked-page logic (quotes, Pomodoro countdown) |
| `quotes.js` | 35 built-in inspirational quotes |
| `icons/` | icon16/48/128 PNG files (Python-generated: shield + lock on purple circle) |

### Storage schema
- `chrome.storage.local`: `blocklistEncrypted`, `blocklistIV`, `schedules[]`, `pomodoroSettings`, `passwordHash`, `passwordSalt`, `customQuotes`, `alwaysBlock`, `hardModeUntil`
- `chrome.storage.session`: `sessionUnlocked`, `sessionEncKey`, `failedAttempts`, `lockoutUntil`, `pomodoroRunning`, `pomodoroPhase`, `pomodoroEndTime`, `pomodoroSessionCount`, `pendingContextMenuDomain`

### Blocking priority (highest → lowest)
1. **Hard Mode** (`hardModeUntil` in future) — always blocks, no override possible
2. **Pomodoro** running — work phase = block, break phase = unblock
3. **Always Block** toggle (default ON)
4. **Schedule** — time/day window matching

### Important implementation notes
- **Import via paste modal** (not file picker) — Chrome popup loses focus when OS file picker opens, destroying the popup
- **Context menu title** updates dynamically via `chrome.tabs.onActivated` + `chrome.tabs.onUpdated`; shows "Unblock" when session unlocked and domain is in blocklist
- **Always-block tooltip**: instant CSS `::after` pseudo-element using `data-tooltip` attribute (native `title` has ~1s delay)
- **Hard Mode**: stored in `chrome.storage.local` so it survives browser restarts; alarm `hard_mode_end` re-created on `initExtension()` if still active
- **Schedule migration**: `migrateSchedule()` converts old single `schedule` object → `schedules[]` array (one-time, idempotent)
- **Background.js requires extension reload** at `chrome://extensions` after changes; popup/UI files update on next popup open

## Potential next features
- **Multiple named block lists**: user-created lists, each independently togglable (attempted in commit `e4a8f98` but UI was buggy; needs clean reimplementation)
- **Blocked page "Unblock" button**: when session is unlocked, show a button on `blocked.html` to quickly remove the site
- **Hard Mode on blocked page**: show Hard Mode countdown on `blocked.html` when Hard Mode is active
- **Stats / usage tracking**: track how many times each site was blocked per day

## Developer notes
- Node.js not available on this machine — use Python (`python -c "..."`) for any build scripts
- Always reload the unpacked extension in `chrome://extensions` after `background.js` changes
- Popup/UI file changes (popup.html, popup.js, blocked.html, etc.) take effect on next popup open — no reload needed
- Push to GitHub after every meaningful change set
