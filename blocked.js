// blocked.js — Logic for the blocked-page UI

// ─────────────────────────────────────────────────────────────
// QUOTE
// Approach: pick and render a built-in quote instantly (synchronous),
// then silently try to pull custom quotes from the service worker.
// If that fails or times out (Incognito, cold-start, etc.) the
// built-in quote is already visible — nothing breaks.
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

async function tryUpgradeWithCustomQuote() {
  // Race the sendMessage against a 1.5 s timeout so we never hang.
  // Works even if the service worker is sleeping or unavailable (Incognito).
  let result = null;
  try {
    result = await Promise.race([
      chrome.runtime.sendMessage({ type: 'GET_STATE' }),
      new Promise(resolve => setTimeout(() => resolve(null), 1500))
    ]);
  } catch {
    return; // extension not reachable — keep the built-in quote
  }

  const customQuotes = (result && result.customQuotes) || [];
  if (customQuotes.length === 0) return; // nothing to add

  // Re-pick from the combined pool so custom quotes get a fair chance
  renderQuote(pickRandom([...BUILT_IN_QUOTES, ...customQuotes]));
}

// ─────────────────────────────────────────────────────────────
// BLOCKED DOMAIN
// ─────────────────────────────────────────────────────────────

function loadBlockedDomain() {
  const params = new URLSearchParams(window.location.search);
  const site   = params.get('site');
  document.getElementById('blocked-domain').textContent =
    site ? decodeURIComponent(site) : 'this site';
}

// ─────────────────────────────────────────────────────────────
// POMODORO COUNTDOWN
// ─────────────────────────────────────────────────────────────

async function loadPomodoroCountdown() {
  let pomodoroState;
  try {
    const result = await Promise.race([
      chrome.runtime.sendMessage({ type: 'GET_STATE' }),
      new Promise(resolve => setTimeout(() => resolve(null), 2000))
    ]);
    pomodoroState = result && result.pomodoro;
  } catch {
    return;
  }

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
// BOOT
// ─────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  loadBlockedDomain();

  // 1. Show a built-in quote immediately — works in Incognito, offline, everywhere
  showBuiltInQuote();

  // 2. Asynchronously try to mix in custom quotes (non-blocking)
  tryUpgradeWithCustomQuote();

  // 3. Pomodoro countdown (best-effort)
  loadPomodoroCountdown();
});
