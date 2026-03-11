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

function upgradeWithCustomQuote(state) {
  const customQuotes  = state.customQuotes  || [];
  const useBuiltIn    = state.useBuiltInQuotes !== false;
  const pool = [...(useBuiltIn ? BUILT_IN_QUOTES : []), ...customQuotes];
  if (pool.length === 0) return; // keep the initial built-in shown as fallback
  renderQuote(pickRandom(pool));
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

  // Energy effect: vignette + card glow + rising ember particles
  document.getElementById('hard-overlay').style.display = 'block';
  document.querySelector('.card').classList.add('hard-active');

  const emberColors = ['#ff1a00', '#ff4500', '#ff6600', '#ff9900', '#ffcc00'];
  function spawnEmber() {
    const size   = 2 + Math.random() * 5;
    const x      = Math.random() * window.innerWidth;
    const dy     = -(120 + Math.random() * 340);
    const dx     = (Math.random() - 0.5) * 120;
    const dur    = 1.0 + Math.random() * 1.6;
    const color  = emberColors[Math.floor(Math.random() * emberColors.length)];
    const el     = document.createElement('div');
    el.style.cssText = [
      'position:fixed', `bottom:${Math.random() * 60}px`, `left:${x}px`,
      `width:${size}px`, `height:${size}px`, 'border-radius:50%',
      `background:${color}`, `box-shadow:0 0 ${size * 2.5}px ${color}`,
      'pointer-events:none', 'z-index:2',
      `--dx:${dx}px`, `--dy:${dy}px`,
      `animation:ember-rise ${dur}s ease-out forwards`
    ].join(';');
    document.body.appendChild(el);
    setTimeout(() => el.remove(), dur * 1000 + 100);
  }

  // Initial burst then steady stream
  for (let i = 0; i < 12; i++) setTimeout(spawnEmber, i * 60);
  setInterval(() => { for (let i = 0; i < 2; i++) spawnEmber(); }, 180);

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
// PEEK BUTTON (temporary access, up to 15 min)
// ─────────────────────────────────────────────────────────────

function setupUnblockButton(domain, hasPassword, hardActive) {
  // Never show if Hard Mode is active or domain is unknown
  if (hardActive || domain === 'this site') return;

  const section    = document.getElementById('unblock-section');
  const btn        = document.getElementById('unblock-btn');
  const form       = document.getElementById('unblock-form');
  const pwInput    = document.getElementById('unblock-password');
  const confirmBtn = document.getElementById('unblock-confirm');
  const errorDiv   = document.getElementById('unblock-error');
  section.style.display = 'block';

  // Duration selection
  let selectedMinutes = 5;
  document.querySelectorAll('.peek-dur-btn').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.peek-dur-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      selectedMinutes = parseInt(b.dataset.min, 10);
    });
  });

  async function doPeek() {
    confirmBtn.disabled = true;
    errorDiv.style.display = 'none';

    try {
      const result = await chrome.runtime.sendMessage({
        type:       'PEEK_SITE',
        domain,
        password:   pwInput.value,
        durationMs: selectedMinutes * 60 * 1000
      });

      if (!result || !result.success) {
        const msg = result && result.locked
          ? `Locked out. Try again in ${result.remainingMinutes} min.`
          : result && result.attemptsRemaining != null
            ? `Wrong password. ${result.attemptsRemaining} attempt(s) left.`
            : result && result.error
              ? result.error
              : 'Wrong password.';
        errorDiv.textContent = msg;
        errorDiv.style.display = 'block';
        pwInput.value = '';
        pwInput.focus();
        confirmBtn.disabled = false;
        return;
      }

      // Peek granted — navigate to the site
      confirmBtn.textContent = 'Opening…';
      window.location.href = `https://${domain}`;

    } catch {
      errorDiv.textContent = 'Extension unreachable — try from the popup.';
      errorDiv.style.display = 'block';
      confirmBtn.disabled = false;
    }
  }

  // First click reveals the form
  btn.addEventListener('click', () => {
    btn.style.display = 'none';
    form.style.display = 'block';
    pwInput.focus();
  });

  confirmBtn.addEventListener('click', doPeek);
  pwInput.addEventListener('keydown', e => { if (e.key === 'Enter') doPeek(); });
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
    upgradeWithCustomQuote(state);

    const hardActive = !!state.hardModeUntil && Date.now() < state.hardModeUntil;
    if (hardActive) {
      startHardCountdown(state.hardModeUntil);
    }

    startPomoCountdown(state.pomodoro);

    setupUnblockButton(domain, state.hasPassword, hardActive);
  }
});
