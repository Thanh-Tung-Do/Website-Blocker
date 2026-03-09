// blocked.js — Logic for the blocked-page UI

// ─────────────────────────────────────────────────────────────
// QUOTE
// ─────────────────────────────────────────────────────────────

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function renderQuote(quote) {
  document.getElementById('quote-text').textContent   = quote.text;
  document.getElementById('quote-author').textContent = `— ${quote.author}`;
}

function showBuiltInQuote() {
  // BUILT_IN_QUOTES is defined in quotes.js, loaded before this script
  renderQuote(pickRandom(BUILT_IN_QUOTES));
}

function upgradeWithCustomQuote(customQuotes) {
  if (!customQuotes || customQuotes.length === 0) return;
  renderQuote(pickRandom([...BUILT_IN_QUOTES, ...customQuotes]));
}

// ─────────────────────────────────────────────────────────────
// BLOCKED DOMAIN
// ─────────────────────────────────────────────────────────────

function getBlockedDomain() {
  const params = new URLSearchParams(window.location.search);
  const site   = params.get('site');
  const domain = site ? decodeURIComponent(site) : 'this site';
  document.getElementById('blocked-domain').textContent = domain;
  return domain;
}

// ─────────────────────────────────────────────────────────────
// HARD MODE COUNTDOWN
// ─────────────────────────────────────────────────────────────

function startHardCountdown(hardModeUntil) {
  const section   = document.getElementById('hard-section');
  const countdown = document.getElementById('hard-countdown');
  section.style.display = 'block';

  function tick() {
    const remaining = Math.max(0, hardModeUntil - Date.now());
    const totalSecs = Math.floor(remaining / 1000);
    const h = Math.floor(totalSecs / 3600);
    const m = Math.floor((totalSecs % 3600) / 60);
    const s = totalSecs % 60;
    if (h > 0) {
      countdown.textContent =
        `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    } else {
      countdown.textContent =
        `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
  }

  tick();
  setInterval(tick, 1000);
}

// ─────────────────────────────────────────────────────────────
// POMODORO COUNTDOWN
// ─────────────────────────────────────────────────────────────

function startPomoCountdown(pomodoroState) {
  if (!pomodoroState || !pomodoroState.running) return;

  const section   = document.getElementById('pomo-section');
  const countdown = document.getElementById('pomo-countdown');
  const phaseText = document.getElementById('pomo-phase-text');
  section.style.display = 'block';

  function tick() {
    if (!pomodoroState.endTime) return;
    const remaining = Math.max(0, pomodoroState.endTime - Date.now());
    const secs = Math.floor(remaining / 1000);
    const m = Math.floor(secs / 60).toString().padStart(2, '0');
    const s = (secs % 60).toString().padStart(2, '0');
    countdown.textContent = `${m}:${s}`;
    phaseText.textContent = pomodoroState.phase === 'work'
      ? 'until your next break'
      : 'left in break — then back to work';
  }

  tick();
  setInterval(tick, 1000);
}

// ─────────────────────────────────────────────────────────────
// UNBLOCK BUTTON
// ─────────────────────────────────────────────────────────────

function setupUnblockButton(domain, sessionUnlocked, hardActive) {
  // Only show when session is unlocked and Hard Mode is not forcing the block
  if (!sessionUnlocked || hardActive || domain === 'this site') return;

  const section = document.getElementById('unblock-section');
  const btn     = document.getElementById('unblock-btn');
  section.style.display = 'block';

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Removing…';
    try {
      const result = await chrome.runtime.sendMessage({ type: 'REMOVE_SITE', domain });
      if (result && result.success) {
        btn.textContent = 'Unblocked!';
        // Redirect back to the site after a brief moment
        setTimeout(() => {
          window.location.href = `https://${domain}`;
        }, 600);
      } else {
        btn.textContent = 'Failed — try from the popup';
        btn.disabled = false;
      }
    } catch {
      btn.textContent = 'Failed — try from the popup';
      btn.disabled = false;
    }
  });
}

// ─────────────────────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  const domain = getBlockedDomain();

  // 1. Show a built-in quote immediately — works in Incognito, offline, everywhere
  showBuiltInQuote();

  // 2. Single GET_STATE call (2 s timeout) — drives custom quotes, Hard Mode, Pomodoro, Unblock btn
  let state = null;
  try {
    state = await Promise.race([
      chrome.runtime.sendMessage({ type: 'GET_STATE' }),
      new Promise(resolve => setTimeout(() => resolve(null), 2000))
    ]);
  } catch {
    // Service worker unreachable — built-in quote already visible, nothing else shown
  }

  if (state) {
    upgradeWithCustomQuote(state.customQuotes);

    const hardActive = !!state.hardModeUntil && Date.now() < state.hardModeUntil;
    if (hardActive) {
      startHardCountdown(state.hardModeUntil);
    }

    startPomoCountdown(state.pomodoro);

    setupUnblockButton(domain, state.sessionUnlocked, hardActive);
  }
});
