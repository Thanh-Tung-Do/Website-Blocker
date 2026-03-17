# Website Blocker

A powerful Chrome extension (Manifest V3) that helps you stay focused by blocking distracting websites — with scheduling, Pomodoro timer, Hard Mode, and master password protection.

---

## Features

### Blocking Modes
- **Always Block** — keep sites blocked at all times with a single toggle
- **Schedule** — block sites only during specific days and time windows (supports multiple named schedules)
- **Pomodoro** — automatically block during work phases and unblock during breaks
- **Hard Mode** — time-locked blocking (hours + minutes) that cannot be stopped early, even with a password; survives browser restarts

### Block Lists
- Create multiple **named block lists** (e.g. Social Media, News, Shopping)
- Assign different lists to different modes independently
- **Private lists** — hidden everywhere and always active in all blocking modes; reveal them in Settings → Privacy
- Add sites by typing or via **right-click → Block this website**
- **Export** your list as a plain text file; **Import** via paste

### Peek (Temporary Access)
- Temporarily unblock a site for **5, 10, or 15 minutes** with a password
- The site re-blocks automatically when the timer expires
- Not available during Hard Mode

### Quotes
- 35 built-in motivational quotes shown on the blocked page
- **Manage Quotes** — add, edit, or delete any quote (including built-ins)
- Toggle built-in quotes on/off
- Import quotes from JSON or plain text; export your custom quotes

### Security
- **Master password** protected with PBKDF2 (200,000 iterations, SHA-256) + AES-GCM encrypted block lists
- 5-attempt lockout (10-minute cooldown) to prevent brute force
- Session unlock — one password entry per browser session
- Legacy SHA-256 accounts auto-migrate to PBKDF2 on first login

---

## Installation

> This extension is not yet on the Chrome Web Store. Install it manually as an unpacked extension.

1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the project folder
5. The Website Blocker icon will appear in your toolbar

---

## Usage

### First Setup
1. Click the extension icon to open the popup
2. Go to **Settings** and set a master password — this encrypts your block lists
3. Head to the **Sites** tab to create a list and add sites

### Adding Sites
- **From the popup:** Select a list from the dropdown in the Sites tab, type a domain, press Enter or click Add
- **Right-click:** Right-click any page and choose "Block this website" to add it instantly

### Blocking Modes
Each mode is controlled from the **Block** tab:
- **Always Block** — flip the toggle; turn it off with your password
- **Hard Mode** — set a duration (hours + minutes) and confirm with your password; cannot be cancelled

The **Schedule** tab lets you add named schedules with day-of-week and time window settings.

The **Pomodoro** tab lets you configure work/break durations and start a focus session.

### Peek (Temporary Access)
On a blocked page, click **"I need access"**, enter your password, choose a duration (5/10/15 min), and confirm.

### Managing Quotes
In **Settings → Quotes**, click **Manage Quotes** to:
- View all 35 built-in quotes and your custom quotes
- Edit or delete any quote
- Restore a built-in quote you edited or deleted
- Add new custom quotes

Use **Import** to paste a JSON array (`[{"text":"...","author":"..."}]`) or plain text (`Quote — Author`, one per line). Use **Export** to save your custom quotes as a `.json` file.

---

## Privacy

All data (block lists, schedules, password hash, quotes) is stored **locally** in `chrome.storage.local`. Nothing is sent to any server. Block lists are encrypted with your master password using AES-GCM before being written to storage.

---

## Tech Stack

- Chrome Extension Manifest V3
- `declarativeNetRequest` for URL blocking
- `chrome.alarms` for Pomodoro and schedule timing
- `chrome.storage.local` + `chrome.storage.session` for persistent and session state
- PBKDF2 + AES-GCM via the Web Crypto API for password and encryption
- Vanilla JS / HTML / CSS — no frameworks, no build step
