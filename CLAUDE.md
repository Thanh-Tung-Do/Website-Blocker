# Website Blocker — Chrome Extension (MV3)

## Repository
GitHub: https://github.com/Thanh-Tung-Do/Website-Blocker
Branch: `master`

## Current State (as of 2026-03-11)

### What is working
- **Blocking**: declarativeNetRequest with `regexFilter` rules, redirects to `blocked.html?site=DOMAIN`
- **Immediate tab blocking**: `redirectBlockedTabs(domains)` queries all open tabs and redirects matching ones instantly — no page refresh needed
- **Always Block toggle**: default ON (header pill), pure CSS, instant CSS tooltip via `data-tooltip` + `::after`; turning OFF requires password
- **Multiple schedules**: named schedule cards (enabled/disabled dot), add/edit form; saving/deleting requires password (modal button label changes to "Save")
- **Pomodoro**: work/break phases via `chrome.alarms`, badge W/B, notifications; stop requires confirm dialog
- **Hard Mode**: timer-based lock (hours + minutes); overrides ALL other modes; persists across browser restarts via `chrome.storage.local`; `HM` badge on icon; cannot be stopped early
- **Master password**: PBKDF2 (200k iter, SHA-256) + AES-GCM encrypted blocklist, 5-attempt lockout (10 min), session unlock; legacy SHA-256 accounts auto-migrated on first login
- **Context menu**: right-click shows "Block this website" or "Unblock this website" based on current blocklist; updates dynamically on tab switch (`tabs` permission + `onActivated`/`onUpdated`)
- **Export / Import blocklist**: Export downloads `blocklist.txt`; Import uses paste-modal (file-picker approach dropped due to Chrome popup focus loss bug)
- **Blocked page**: 35 built-in quotes + custom quotes, Pomodoro countdown, domain shown
- **Peek**: temporary access to a blocked site for 5/10/15 min (max 15); password required; auto-blocks again on expiry via `peek_end` alarm + `redirectBlockedTabs`
- **Custom quotes**: add/remove from Settings tab
- **Custom icon**: shield + closed padlock on purple gradient circle (Python-generated PNG, all 3 sizes)

### Sites tab
- Multiple named block lists: `blockListsEncrypted` + `blockListsIV` — AES-GCM encrypted `[{id, name, sites[]}]`
- List selector dropdown at top: "All Lists" (aggregate) or a specific list
- "All Lists" view: sites grouped by list name, read-only (add requires selecting a specific list)
- Create / Rename / Delete lists (rename + delete require password)
- Hidden by default — "Reveal Blocked Sites" requires password
- After revealing: domains shown with ✕ remove buttons per list; "Hide list" button to re-hide
- Adding a site does NOT require password (only viewing/removing does)
- Export: specific list = plain domains; "All Lists" = multi-list format with `# List: Name` headers
- Import: detects `# List: Name` headers → merges into named lists; plain format → imports to selected list

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
- `chrome.storage.local`: `blockListsEncrypted`, `blockListsIV`, `schedules[]` (each has `lists` field), `pomodoroSettings` (has `lists` field), `passwordHash`, `passwordSalt`, `customQuotes`, `alwaysBlock`, `alwaysBlockLists`, `hardModeUntil`, `hardModeLists`
- `chrome.storage.session`: `sessionUnlocked`, `sessionEncKey`, `failedAttempts`, `lockoutUntil`, `pomodoroRunning`, `pomodoroPhase`, `pomodoroEndTime`, `pomodoroSessionCount`, `pendingContextMenuDomain`, `peekDomain`, `peekUntil`
- Mode list IDs: `['__all__']` = use all lists; or array of specific list IDs

### Blocking priority (highest → lowest)
1. **Hard Mode** (`hardModeUntil` in future) — always blocks, no override possible; Peek is blocked during Hard Mode
2. **Peek** (`peekDomain` + `peekUntil` in session) — priority-2 allow rule (`PEEK_RULE_ID = 9999`) overrides block rules temporarily
3. **Pomodoro** running — work phase = block, break phase = unblock
4. **Always Block** toggle (default ON)
5. **Schedule** — time/day window matching

### Important implementation notes
- **Import via paste modal** (not file picker) — Chrome popup loses focus when OS file picker opens, destroying the popup
- **Context menu title** updates dynamically via `chrome.tabs.onActivated` + `chrome.tabs.onUpdated`; shows "Unblock" when session unlocked and domain is in blocklist
- **Always-block tooltip**: instant CSS `::after` pseudo-element using `data-tooltip` attribute (native `title` has ~1s delay)
- **Hard Mode**: stored in `chrome.storage.local` so it survives browser restarts; alarm `hard_mode_end` re-created on `initExtension()` if still active
- **Schedule migration**: `migrateSchedule()` converts old single `schedule` object → `schedules[]` array (one-time, idempotent)
- **Background.js requires extension reload** at `chrome://extensions` after changes; popup/UI files update on next popup open
- **Password modal button label**: `confirmWithPassword(title, body, callback, btnLabel)` — `btnLabel` sets `#btn-reveal-submit` text dynamically; defaults to `'Confirm'`
- **Peek allow rule**: `PEEK_RULE_ID = 9999`, priority 2 — re-added by `updateBlockingRules()` on every rule refresh so the schedule alarm (every minute) doesn't remove it
- **Immediate blocking**: `redirectBlockedTabs(domains)` called at: addSite, import (new domains), enable always-block, start Hard Mode, start Pomodoro, break→work transition, schedule activation
- **Blocklist encryption**: `getDecryptedBlocklist()` returns `null` when session locked — `updateBlockingRules()` leaves existing rules unchanged in that case (rules persist natively across Chrome restarts)
- **Password migration**: `verifyPassword()` detects absent `passwordSalt` → legacy SHA-256 → migrates to PBKDF2 + wraps old flat `blocklist` into `[{id, name:'Default', sites}]` format
- **blocklistEncrypted migration**: on first login after multi-list upgrade, old `blocklistEncrypted` → auto-converted to `blockListsEncrypted` with a single "Default" list
- **Multiple block lists**: `getDomainsFromLists(lists, listIds)` resolves `__all__` or specific IDs → unique domain array; each mode stores its own `listIds`
- **Context menu block**: adds to first list; context menu unblock: removes from all lists
- **Import format**: `# List: Name` headers auto-detected; plain format imports to the list selected in the modal dropdown

## Potential next features
- **Multiple named block lists**: ✅ DONE (2026-03-11) — list management in Sites tab, per-mode list selection via chips
- **Focus Stats Dashboard**: track blocks per site per day, peak distraction hours (heatmap), peek usage, Hard Mode activations — new Stats tab in popup; 30-day rolling window in `chrome.storage.local`
- **Intention Gate**: require user to type a reason before Peek unlocks — forces conscious decision-making; low effort, high behavioral impact
- **Pattern-Based Auto Hard Mode**: detect 3+ blocked attempts in 10 min → auto-activate Hard Mode for 30 min; no user input needed
- **Commitment Contract Mode**: user sets a goal + deadline (signed with password), shown on blocked.html alongside quotes
- **Accountability Partner**: shareable read-only focus report (requires backend); highest differentiation vs. competitors
- **Hard Mode on blocked page**: show Hard Mode countdown on `blocked.html` when Hard Mode is active

> Full feature ideas with implementation notes: `D:\Obsidian Vault\Ryansim\Website Blocker — Feature Ideas.md`

## Developer notes
- Node.js not available on this machine — use Python (`python -c "..."`) for any build scripts
- Always reload the unpacked extension in `chrome://extensions` after `background.js` changes
- Popup/UI file changes (popup.html, popup.js, blocked.html, etc.) take effect on next popup open — no reload needed
- Push to GitHub after every meaningful change set
