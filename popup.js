// popup.js — Popup UI logic

// ─────────────────────────────────────────────────────────────
// MESSAGING
// ─────────────────────────────────────────────────────────────

function send(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      resolve(response);
    });
  });
}

// ─────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────

let state = null;
let countdownInterval = null;
let hardCountdownInterval = null;
let selectedDays = new Set([1, 2, 3, 4, 5]);
let editingScheduleId = null; // null = adding new

// Per-popup: whether the blocklist has been revealed this session
let sitesRevealed = false;

// Generic "confirm with password" callback
let pendingPasswordCallback = null;

// ─────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await refreshState();
  setupTabs();
  setupSitesTab();
  setupScheduleTab();
  setupPomodoroTab();
  setupHardModeTab();
  setupSettingsTab();
  setupModalButtons();
  setupLockButton();
  setupBlockToggle();
  renderUI();
});

async function refreshState() {
  state = await send({ type: 'GET_STATE' });
}

// ─────────────────────────────────────────────────────────────
// RENDER ROUTER
// ─────────────────────────────────────────────────────────────

function renderUI() {
  if (!state.hasPassword) {
    showModal('setup');
    return;
  }
  if (!state.sessionUnlocked) {
    showModal('unlock');
    return;
  }
  hideModal();
  renderHeader();
  renderSitesList();
  renderScheduleTab();
  renderPomodoroTab();
  renderHardModeTab();
  renderSettingsTab();
  handlePendingContextMenu();
}

// ─────────────────────────────────────────────────────────────
// HEADER — always-block toggle
// ─────────────────────────────────────────────────────────────

function renderHeader() {
  const pill      = document.getElementById('block-pill');
  const label     = document.getElementById('block-pill-label');
  const badge     = document.getElementById('hard-badge');
  const on        = !!state.alwaysBlock;
  const hardActive = !!(state.hardModeUntil && Date.now() < state.hardModeUntil);

  // Hard Mode badge
  badge.classList.toggle('visible', hardActive);

  // Pill state
  pill.classList.toggle('on',  on);
  pill.classList.toggle('off', !on);
  label.textContent = on ? 'Always Block: ON' : 'Always Block: OFF';

  // Disable pill when hard mode is active
  pill.style.opacity       = hardActive ? '0.4' : '';
  pill.style.pointerEvents = hardActive ? 'none' : '';

  // Instant CSS tooltip via data-tooltip (avoids browser title-attribute delay)
  if (hardActive) {
    pill.dataset.tooltip = 'Always Block is locked — Hard Mode is active.';
  } else if (on) {
    pill.dataset.tooltip = 'Always Block ON: sites in your list are blocked at all times until you turn this off.';
  } else {
    pill.dataset.tooltip = 'Always Block OFF: blocking only activates during scheduled times.';
  }
  pill.removeAttribute('title');
}

// ─────────────────────────────────────────────────────────────
// ALWAYS-BLOCK TOGGLE
// ─────────────────────────────────────────────────────────────

function setupBlockToggle() {
  document.getElementById('block-pill').addEventListener('click', async (e) => {
    e.stopPropagation(); // prevent any ancestor handlers from seeing this
    if (state.hardModeUntil && Date.now() < state.hardModeUntil) return; // hard mode locks this
    if (!state.sessionUnlocked) { showModal('unlock'); return; }

    const newVal = !state.alwaysBlock;

    // Turning OFF always-block requires password confirmation
    if (!newVal) {
      confirmWithPassword(
        '🔒 Disable Always-Block',
        'Enter your master password to turn off always-block mode.',
        async () => {
          state.alwaysBlock = false;
          renderHeader();
          const result = await send({ type: 'SET_ALWAYS_BLOCK', enabled: false });
          if (result && result.error) {
            state.alwaysBlock = true;
            renderHeader();
            alert(result.error);
          }
        },
        'Disable'
      );
      return;
    }

    // Turning ON — no password needed
    state.alwaysBlock = true;
    renderHeader();
    const result = await send({ type: 'SET_ALWAYS_BLOCK', enabled: true });
    if (result && result.error) {
      state.alwaysBlock = false;
      renderHeader();
      alert(result.error);
    }
  });
}

// ─────────────────────────────────────────────────────────────
// TABS
// ─────────────────────────────────────────────────────────────

function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    });
  });
}

// ─────────────────────────────────────────────────────────────
// GENERIC PASSWORD CONFIRMATION
// ─────────────────────────────────────────────────────────────

// Shows the "reveal" modal repurposed as a generic password gate.
// title   — heading text
// body    — instruction paragraph
// callback — async fn called only if password is verified
function confirmWithPassword(title, body, callback, btnLabel = 'Confirm') {
  pendingPasswordCallback = callback;
  document.getElementById('reveal-modal-title').textContent = title;
  document.getElementById('reveal-modal-body').textContent  = body;
  document.getElementById('btn-reveal-submit').textContent  = btnLabel;
  document.getElementById('reveal-pw').value = '';
  document.getElementById('reveal-error').classList.remove('visible');
  showModal('reveal');
}

// ─────────────────────────────────────────────────────────────
// SITES TAB
// ─────────────────────────────────────────────────────────────

function setupSitesTab() {
  document.getElementById('btn-add-site').addEventListener('click', addSite);
  document.getElementById('site-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') addSite();
  });
  document.getElementById('btn-export-sites').addEventListener('click', exportBlocklist);
  document.getElementById('btn-import-sites').addEventListener('click', () => {
    document.getElementById('import-textarea').value = '';
    document.getElementById('import-error').classList.remove('visible');
    showModal('import');
  });

  document.getElementById('btn-reveal-sites').addEventListener('click', () => {
    confirmWithPassword(
      '🔒 Reveal Blocklist',
      'Enter your master password to view the list of blocked sites.',
      () => { sitesRevealed = true; renderSitesList(); },
      'Show Sites'
    );
  });

  document.getElementById('btn-hide-sites').addEventListener('click', () => {
    sitesRevealed = false;
    renderSitesList();
  });
}

async function addSite() {
  if (!state.sessionUnlocked) { showModal('unlock'); return; }

  const input = document.getElementById('site-input');
  let domain  = input.value.trim().toLowerCase();
  if (!domain) return;

  try {
    if (domain.includes('://')) domain = new URL(domain).hostname;
    domain = domain.replace(/^www\./, '').split('/')[0];
  } catch { /* keep as-is */ }

  if (!domain || !domain.includes('.')) {
    showInlineError('site-input', 'Enter a valid domain (e.g. reddit.com)');
    return;
  }

  const result = await send({ type: 'ADD_SITE', domain });
  if (result.error) { alert(result.error); return; }

  input.value    = '';
  state.blocklist = result.blocklist;
  renderSitesList();
}

function renderSitesList() {
  const hiddenState    = document.getElementById('sites-hidden-state');
  const listContainer  = document.getElementById('site-list-container');
  const countText      = document.getElementById('sites-count-text');
  const list           = document.getElementById('site-list');
  const empty          = document.getElementById('site-empty');
  const sites          = state.blocklist || [];

  const n = sites.length;
  countText.textContent = n === 0
    ? 'No sites blocked yet'
    : `${n} site${n !== 1 ? 's' : ''} blocked`;

  if (!sitesRevealed) {
    hiddenState.style.display   = 'block';
    listContainer.style.display = 'none';
    return;
  }

  hiddenState.style.display   = 'none';
  listContainer.style.display = 'block';
  list.innerHTML = '';

  if (sites.length === 0) {
    empty.style.display = 'block';
    return;
  }

  empty.style.display = 'none';
  sites.forEach(domain => {
    const item = document.createElement('div');
    item.className = 'site-item';
    item.innerHTML = `<span title="${escapeHtml(domain)}">${escapeHtml(domain)}</span><button title="Remove">✕</button>`;
    item.querySelector('button').addEventListener('click', () => removeSite(domain));
    list.appendChild(item);
  });
}

async function removeSite(domain) {
  if (!state.sessionUnlocked) { showModal('unlock'); return; }
  const result = await send({ type: 'REMOVE_SITE', domain });
  if (result.error) { alert(result.error); return; }
  state.blocklist = result.blocklist;
  renderSitesList();
}

function exportBlocklist() {
  if (!state.sessionUnlocked) { showModal('unlock'); return; }
  const sites = state.blocklist || [];
  if (sites.length === 0) { alert('Your blocklist is empty.'); return; }
  const blob = new Blob([sites.join('\n')], { type: 'text/plain' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'blocklist.txt';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function importBlocklist() {
  if (!state.sessionUnlocked) { showModal('unlock'); return; }

  const text    = document.getElementById('import-textarea').value;
  const err     = document.getElementById('import-error');
  err.classList.remove('visible');

  const domains = text.split(/\r?\n/)
    .map(l => {
      let d = l.trim().toLowerCase();
      if (!d || d.startsWith('#')) return '';
      try { if (d.includes('://')) d = new URL(d).hostname; } catch { return ''; }
      d = d.replace(/^www\./, '').split('/')[0];
      return (d.includes('.') && !d.includes(' ') && d.length <= 253) ? d : '';
    })
    .filter(Boolean);

  if (domains.length === 0) {
    showError(err, 'No valid domains found. Enter one domain per line.');
    return;
  }

  const result = await send({ type: 'IMPORT_SITES', domains });
  if (result.error) { showError(err, result.error); return; }

  state.blocklist = result.blocklist;
  document.getElementById('import-textarea').value = '';
  hideModal();
  renderSitesList();

  const btn  = document.getElementById('btn-import-sites');
  const orig = btn.textContent;
  btn.textContent = result.added > 0 ? `${result.added} imported` : 'No new sites';
  setTimeout(() => { btn.textContent = orig; }, 2500);
}

function showInlineError(inputId, msg) {
  const input = document.getElementById(inputId);
  input.style.borderColor = 'var(--danger)';
  input.title = msg;
  setTimeout(() => { input.style.borderColor = ''; input.title = ''; }, 2000);
}

// ─────────────────────────────────────────────────────────────
// SCHEDULE TAB  — every save/delete requires password re-entry
// ─────────────────────────────────────────────────────────────

function setupScheduleTab() {
  document.querySelectorAll('.day-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const day = parseInt(btn.dataset.day);
      if (selectedDays.has(day)) { selectedDays.delete(day); btn.classList.remove('selected'); }
      else                        { selectedDays.add(day);    btn.classList.add('selected'); }
    });
  });
  document.getElementById('btn-save-schedule').addEventListener('click', saveSchedule);
  document.getElementById('btn-cancel-schedule').addEventListener('click', resetScheduleForm);
}

function resetScheduleForm() {
  editingScheduleId = null;
  document.getElementById('sched-form-title').textContent = 'Add Schedule';
  document.getElementById('schedule-name').value          = '';
  document.getElementById('schedule-enabled').checked     = true;
  document.getElementById('schedule-start').value         = '09:00';
  document.getElementById('schedule-end').value           = '17:00';
  selectedDays = new Set([1, 2, 3, 4, 5]);
  document.querySelectorAll('.day-btn').forEach(btn => {
    btn.classList.toggle('selected', selectedDays.has(parseInt(btn.dataset.day)));
  });
  document.getElementById('btn-cancel-schedule').style.display = 'none';
}

function renderScheduleTab() {
  const schedules = state.schedules || [];
  const list  = document.getElementById('schedule-list');
  const empty = document.getElementById('schedule-empty');
  list.innerHTML = '';

  const DAY_ABBR = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

  if (schedules.length === 0) {
    empty.style.display = 'block';
  } else {
    empty.style.display = 'none';
    schedules.forEach(sched => {
      const dayStr  = (sched.days || []).sort((a, b) => a - b).map(d => DAY_ABBR[d]).join(' ');
      const card    = document.createElement('div');
      card.className = 'sched-card';
      card.innerHTML = `
        <div class="sched-card-dot ${sched.enabled ? 'on' : 'off'}"></div>
        <div class="sched-card-info">
          <div class="sched-card-name">${escapeHtml(sched.name || 'Schedule')}</div>
          <div class="sched-card-sub">${escapeHtml(sched.startTime)} – ${escapeHtml(sched.endTime)} · ${escapeHtml(dayStr || 'No days')}</div>
        </div>
        <div class="sched-card-btns">
          <button class="edit" title="Edit">✏</button>
          <button class="del"  title="Delete">✕</button>
        </div>
      `;
      card.querySelector('.edit').addEventListener('click', () => startEditSchedule(sched));
      card.querySelector('.del').addEventListener('click',  () => deleteSchedule(sched.id));
      list.appendChild(card);
    });
  }

  if (!editingScheduleId) resetScheduleForm();
}

function startEditSchedule(sched) {
  editingScheduleId = sched.id;
  document.getElementById('sched-form-title').textContent    = 'Edit Schedule';
  document.getElementById('schedule-name').value             = sched.name || '';
  document.getElementById('schedule-enabled').checked        = !!sched.enabled;
  document.getElementById('schedule-start').value            = sched.startTime || '09:00';
  document.getElementById('schedule-end').value              = sched.endTime   || '17:00';
  selectedDays = new Set(sched.days || []);
  document.querySelectorAll('.day-btn').forEach(btn => {
    btn.classList.toggle('selected', selectedDays.has(parseInt(btn.dataset.day)));
  });
  document.getElementById('btn-cancel-schedule').style.display = 'inline-flex';
  document.getElementById('schedule-form').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function saveSchedule() {
  if (!state.sessionUnlocked) { showModal('unlock'); return; }

  // Capture form values before the modal opens
  const entry = {
    id:        editingScheduleId || Date.now(),
    name:      document.getElementById('schedule-name').value.trim() || 'Schedule',
    enabled:   document.getElementById('schedule-enabled').checked,
    startTime: document.getElementById('schedule-start').value,
    endTime:   document.getElementById('schedule-end').value,
    days:      [...selectedDays]
  };

  const existing     = state.schedules || [];
  const newSchedules = editingScheduleId
    ? existing.map(s => s.id === editingScheduleId ? entry : s)
    : [...existing, entry];

  confirmWithPassword(
    '🔒 Save Schedule',
    'Enter your master password to save changes to the blocking schedule.',
    async () => {
      const result = await send({ type: 'UPDATE_SCHEDULES', schedules: newSchedules });
      if (result.error) { alert(result.error); return; }
      state.schedules = newSchedules;
      resetScheduleForm();
      renderScheduleTab();
      flashButton('btn-save-schedule', 'Saved!');
    },
    'Save'
  );
}

function deleteSchedule(id) {
  if (!state.sessionUnlocked) { showModal('unlock'); return; }
  const newSchedules = (state.schedules || []).filter(s => s.id !== id);
  confirmWithPassword(
    '🔒 Delete Schedule',
    'Enter your master password to delete this schedule.',
    async () => {
      const result = await send({ type: 'UPDATE_SCHEDULES', schedules: newSchedules });
      if (result.error) { alert(result.error); return; }
      state.schedules = newSchedules;
      if (editingScheduleId === id) resetScheduleForm();
      renderScheduleTab();
    },
    'Delete'
  );
}

// ─────────────────────────────────────────────────────────────
// POMODORO TAB
// ─────────────────────────────────────────────────────────────

function setupPomodoroTab() {
  document.getElementById('btn-pomo-start').addEventListener('click', startPomodoro);
  document.getElementById('btn-pomo-stop').addEventListener('click', stopPomodoro);
  document.getElementById('btn-save-pomo').addEventListener('click', savePomodoroSettings);
}

function renderPomodoroTab() {
  clearInterval(countdownInterval);

  const pomo = state.pomodoro;
  document.getElementById('pomo-work').value  = pomo.settings.workDuration  || 25;
  document.getElementById('pomo-break').value = pomo.settings.breakDuration || 5;
  document.getElementById('pomo-sessions').textContent = `Sessions completed: ${pomo.sessionCount || 0}`;

  const startBtn = document.getElementById('btn-pomo-start');
  const stopBtn  = document.getElementById('btn-pomo-stop');

  if (pomo.running) {
    startBtn.style.display = 'none';
    stopBtn.style.display  = 'inline-flex';
    startCountdownTick();
  } else {
    startBtn.style.display = 'inline-flex';
    stopBtn.style.display  = 'none';
    document.getElementById('pomo-phase').textContent     = 'Idle';
    document.getElementById('pomo-countdown').textContent = formatTime((pomo.settings.workDuration || 25) * 60);
    document.getElementById('pomo-countdown').className   = 'pomo-countdown idle';
  }
}

function startCountdownTick() {
  function tick() {
    const pomo = state.pomodoro;
    if (!pomo.running || !pomo.endTime) return;

    const remaining = Math.max(0, pomo.endTime - Date.now());
    const secs = Math.floor(remaining / 1000);

    document.getElementById('pomo-countdown').textContent = formatTime(secs);
    document.getElementById('pomo-phase').textContent     = pomo.phase === 'work' ? 'Work' : 'Break';
    document.getElementById('pomo-countdown').className   =
      `pomo-countdown ${pomo.phase === 'work' ? 'work' : 'break'}`;

    if (remaining <= 0) {
      clearInterval(countdownInterval);
      setTimeout(async () => { await refreshState(); renderPomodoroTab(); renderHeader(); }, 1500);
    }
  }
  tick();
  countdownInterval = setInterval(tick, 500);
}

function formatTime(totalSeconds) {
  const m = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const s = (totalSeconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

async function startPomodoro() {
  if (!state.sessionUnlocked) { showModal('unlock'); return; }
  const result = await send({ type: 'START_POMODORO' });
  if (result.error) { alert(result.error); return; }
  await refreshState();
  renderPomodoroTab();
  renderHeader();
}

async function stopPomodoro() {
  if (!state.sessionUnlocked) { showModal('unlock'); return; }
  showConfirm(
    'Stop Pomodoro?',
    'This will end the current session and restore normal blocking mode.',
    async () => {
      const result = await send({ type: 'STOP_POMODORO' });
      if (result.error) { alert(result.error); return; }
      await refreshState();
      renderPomodoroTab();
      renderHeader();
    }
  );
}

async function savePomodoroSettings() {
  if (!state.sessionUnlocked) { showModal('unlock'); return; }
  const settings = {
    workDuration:  Math.max(1, parseInt(document.getElementById('pomo-work').value)  || 25),
    breakDuration: Math.max(1, parseInt(document.getElementById('pomo-break').value) || 5)
  };
  const result = await send({ type: 'UPDATE_POMODORO_SETTINGS', settings });
  if (result.error) { alert(result.error); return; }
  state.pomodoro.settings = settings;
  flashButton('btn-save-pomo', 'Saved!');
}

// ─────────────────────────────────────────────────────────────
// HARD MODE TAB
// ─────────────────────────────────────────────────────────────

function setupHardModeTab() {
  document.getElementById('btn-hard-start').addEventListener('click', startHardMode);
}

function renderHardModeTab() {
  clearInterval(hardCountdownInterval);

  const hardActive = !!(state.hardModeUntil && Date.now() < state.hardModeUntil);
  document.getElementById('hard-idle').style.display   = hardActive ? 'none'  : 'flex';
  document.getElementById('hard-active').style.display = hardActive ? 'flex'  : 'none';

  if (!hardActive) return;

  function tick() {
    const remaining = Math.max(0, state.hardModeUntil - Date.now());
    const totalSecs = Math.floor(remaining / 1000);
    const h = Math.floor(totalSecs / 3600).toString().padStart(2, '0');
    const m = Math.floor((totalSecs % 3600) / 60).toString().padStart(2, '0');
    const s = (totalSecs % 60).toString().padStart(2, '0');
    document.getElementById('hard-countdown').textContent = `${h}:${m}:${s}`;
    if (remaining <= 0) {
      clearInterval(hardCountdownInterval);
      setTimeout(async () => {
        await refreshState();
        renderHardModeTab();
        renderHeader();
      }, 1500);
    }
  }
  tick();
  hardCountdownInterval = setInterval(tick, 500);
}

async function startHardMode() {
  if (!state.sessionUnlocked) { showModal('unlock'); return; }

  const hours   = Math.max(0, parseInt(document.getElementById('hard-hours').value)   || 0);
  const minutes = Math.max(0, parseInt(document.getElementById('hard-minutes').value) || 0);
  const durationMs = (hours * 60 + minutes) * 60 * 1000;

  if (durationMs < 60000) {
    alert('Set a duration of at least 1 minute.');
    return;
  }

  const total = hours > 0
    ? `${hours}h ${minutes}m`
    : `${minutes} minute${minutes !== 1 ? 's' : ''}`;

  showConfirm(
    '🔥 Start Hard Mode?',
    `Blocking will be locked for ${total}. You will NOT be able to stop it early — no toggles, no password bypass, no exceptions. Are you sure?`,
    async () => {
      const result = await send({ type: 'START_HARD_MODE', durationMs });
      if (result.error) { alert(result.error); return; }
      state.hardModeUntil = result.hardModeUntil;
      renderHeader();
      renderHardModeTab();
    }
  );
}

// ─────────────────────────────────────────────────────────────
// SETTINGS TAB
// ─────────────────────────────────────────────────────────────

function setupSettingsTab() {
  document.getElementById('btn-change-pw').addEventListener('click', changePassword);
  document.getElementById('btn-add-quote').addEventListener('click', addCustomQuote);
  document.getElementById('btn-reset').addEventListener('click', () => {
    confirmWithPassword(
      '⚠️ Reset All Settings?',
      'Enter your master password to permanently erase your blocklist, schedule, password, and all settings. This cannot be undone.',
      async () => {
        await send({ type: 'RESET_ALL' });
        sitesRevealed = false;
        await refreshState();
        renderUI();
      },
      'Reset Everything'
    );
  });
}

function renderSettingsTab() {
  renderCustomQuotes();
}

async function changePassword() {
  if (!state.sessionUnlocked) { showModal('unlock'); return; }

  const currentPw = document.getElementById('current-password').value;
  const newPw     = document.getElementById('new-password').value;
  const confirmPw = document.getElementById('confirm-password').value;

  if (!currentPw)          return alert('Enter your current password.');
  if (!newPw)              return alert('Enter a new password.');
  if (newPw.length < 4)   return alert('New password must be at least 4 characters.');
  if (newPw !== confirmPw) return alert('New passwords do not match.');

  const result = await send({ type: 'CHANGE_PASSWORD', currentPassword: currentPw, newPassword: newPw });
  if (result.error) { alert(result.error); return; }

  document.getElementById('current-password').value = '';
  document.getElementById('new-password').value     = '';
  document.getElementById('confirm-password').value = '';
  flashButton('btn-change-pw', 'Changed!');
}

async function addCustomQuote() {
  if (!state.sessionUnlocked) { showModal('unlock'); return; }
  const text   = document.getElementById('quote-text').value.trim();
  const author = document.getElementById('quote-author').value.trim();
  if (!text) return alert('Enter a quote.');

  const result = await send({ type: 'ADD_CUSTOM_QUOTE', quote: { text, author: author || 'Unknown' } });
  if (result.error) { alert(result.error); return; }

  state.customQuotes = result.customQuotes;
  document.getElementById('quote-text').value   = '';
  document.getElementById('quote-author').value = '';
  renderCustomQuotes();
}

async function removeCustomQuote(index) {
  if (!state.sessionUnlocked) { showModal('unlock'); return; }
  const result = await send({ type: 'REMOVE_CUSTOM_QUOTE', index });
  if (result.error) { alert(result.error); return; }
  state.customQuotes = result.customQuotes;
  renderCustomQuotes();
}

function renderCustomQuotes() {
  const list   = document.getElementById('quote-list');
  const quotes = state.customQuotes || [];
  list.innerHTML = '';

  if (quotes.length === 0) {
    list.innerHTML = '<div style="font-size:11px;color:var(--text-muted);padding:8px 0">No custom quotes added yet.</div>';
    return;
  }

  quotes.forEach((q, i) => {
    const item = document.createElement('div');
    item.className = 'quote-item';
    item.innerHTML = `
      <div class="quote-item-text"><em>${escapeHtml(q.text)}</em> — ${escapeHtml(q.author)}</div>
      <button title="Remove">✕</button>
    `;
    item.querySelector('button').addEventListener('click', () => removeCustomQuote(i));
    list.appendChild(item);
  });
}

// ─────────────────────────────────────────────────────────────
// LOCK BUTTON
// ─────────────────────────────────────────────────────────────

function setupLockButton() {
  document.getElementById('btn-lock').addEventListener('click', async () => {
    await send({ type: 'LOCK_SESSION' });
    state.sessionUnlocked = false;
    sitesRevealed = false;
    pendingPasswordCallback = null;
    renderUI();
  });
}

// ─────────────────────────────────────────────────────────────
// MODALS
// ─────────────────────────────────────────────────────────────

function showModal(name) {
  const overlay = document.getElementById('modal-overlay');
  overlay.classList.add('visible');
  overlay.querySelectorAll('.modal').forEach(m => m.style.display = 'none');
  const modal = document.getElementById(`modal-${name}`);
  if (modal) modal.style.display = 'flex';
}

function hideModal() {
  document.getElementById('modal-overlay').classList.remove('visible');
}

let confirmCallback = null;

function showConfirm(title, body, onConfirm) {
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-body').textContent  = body;
  confirmCallback = onConfirm;
  showModal('confirm');
}

function setupModalButtons() {

  // ── Setup password ───────────────────────────────────────────
  document.getElementById('btn-setup-submit').addEventListener('click', async () => {
    const pw1 = document.getElementById('setup-pw1').value;
    const pw2 = document.getElementById('setup-pw2').value;
    const err = document.getElementById('setup-error');
    err.classList.remove('visible');

    if (!pw1)           { showError(err, 'Please enter a password.'); return; }
    if (pw1.length < 4) { showError(err, 'Password must be at least 4 characters.'); return; }
    if (pw1 !== pw2)    { showError(err, 'Passwords do not match.'); return; }

    const result = await send({ type: 'SETUP_PASSWORD', password: pw1 });
    if (result.error)   { showError(err, result.error); return; }

    state.hasPassword     = true;
    state.sessionUnlocked = true;
    await refreshState();
    renderUI();
  });

  ['setup-pw1', 'setup-pw2'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => {
      if (e.key === 'Enter') document.getElementById('btn-setup-submit').click();
    });
  });

  // ── Unlock session ───────────────────────────────────────────
  document.getElementById('btn-unlock-submit').addEventListener('click', async () => {
    const pw  = document.getElementById('unlock-pw').value;
    const err = document.getElementById('unlock-error');
    err.classList.remove('visible');

    if (!pw) { showError(err, 'Enter your password.'); return; }

    const result = await send({ type: 'VERIFY_PASSWORD', password: pw });

    if (result.success) {
      state.sessionUnlocked = true;
      await refreshState();
      renderUI();
    } else if (result.locked) {
      showError(err, `Too many failed attempts. Try again in ${result.remainingMinutes} minute(s).`);
    } else {
      showError(err, `Incorrect password. ${result.attemptsRemaining} attempt(s) remaining.`);
    }
  });

  document.getElementById('unlock-pw').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-unlock-submit').click();
  });

  document.getElementById('btn-unlock-forgot').addEventListener('click', () => showModal('forgot'));

  // ── Forgot / reset ───────────────────────────────────────────
  document.getElementById('btn-forgot-cancel').addEventListener('click',  () => showModal('unlock'));
  document.getElementById('btn-forgot-confirm').addEventListener('click', async () => {
    await send({ type: 'RESET_ALL' });
    sitesRevealed = false;
    await refreshState();
    renderUI();
  });

  // ── Generic confirm (yes/no) ─────────────────────────────────
  document.getElementById('btn-confirm-cancel').addEventListener('click', () => {
    confirmCallback = null;
    hideModal();
  });
  document.getElementById('btn-confirm-ok').addEventListener('click', async () => {
    hideModal();
    if (confirmCallback) { const cb = confirmCallback; confirmCallback = null; await cb(); }
  });

  // ── Password-confirm modal (reveal + schedule + other actions) ──
  document.getElementById('btn-reveal-submit').addEventListener('click', async () => {
    const pw  = document.getElementById('reveal-pw').value;
    const err = document.getElementById('reveal-error');
    err.classList.remove('visible');

    if (!pw) { showError(err, 'Enter your password.'); return; }

    const result = await send({ type: 'VERIFY_PASSWORD', password: pw });

    if (result.success) {
      hideModal();
      if (pendingPasswordCallback) {
        const cb = pendingPasswordCallback;
        pendingPasswordCallback = null;
        await cb();
      }
    } else if (result.locked) {
      showError(err, `Too many failed attempts. Locked for ${result.remainingMinutes} minute(s).`);
    } else {
      showError(err, `Incorrect password. ${result.attemptsRemaining} attempt(s) remaining.`);
    }
  });

  document.getElementById('reveal-pw').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-reveal-submit').click();
  });

  document.getElementById('btn-reveal-cancel').addEventListener('click', () => {
    pendingPasswordCallback = null;
    document.getElementById('reveal-pw').value = '';
    hideModal();
  });

  // ── Import domains ───────────────────────────────────────────
  document.getElementById('btn-import-cancel').addEventListener('click', () => {
    document.getElementById('import-textarea').value = '';
    document.getElementById('import-error').classList.remove('visible');
    hideModal();
  });
  document.getElementById('btn-import-submit').addEventListener('click', importBlocklist);

  // ── Context menu pending ─────────────────────────────────────
  document.getElementById('btn-ctx-cancel').addEventListener('click', async () => {
    await send({ type: 'CLEAR_PENDING_CONTEXT_MENU' });
    state.pendingContextMenuDomain = null;
    hideModal();
  });
  document.getElementById('btn-ctx-confirm').addEventListener('click', async () => {
    const btn      = document.getElementById('btn-ctx-confirm');
    const isUnblock = btn.dataset.ctxUnblock === '1';
    const result   = await send({
      type: isUnblock ? 'REMOVE_PENDING_CONTEXT_MENU_SITE' : 'ADD_PENDING_CONTEXT_MENU_SITE'
    });
    if (result.error) { alert(result.error); return; }
    state.blocklist = result.blocklist || state.blocklist;
    state.pendingContextMenuDomain = null;
    hideModal();
    renderSitesList();
    renderHeader();
  });
}

// ─────────────────────────────────────────────────────────────
// CONTEXT MENU PENDING
// ─────────────────────────────────────────────────────────────

function handlePendingContextMenu() {
  const pending = state.pendingContextMenuDomain;
  if (!pending) return;
  const isBlocked = (state.blocklist || []).includes(pending);
  document.getElementById('ctx-pending-msg').textContent = isBlocked
    ? `You right-clicked "${pending}" which is currently blocked. Remove it from your blocklist?`
    : `You right-clicked to block "${pending}". Add it to your blocklist now?`;
  const confirmBtn = document.getElementById('btn-ctx-confirm');
  confirmBtn.textContent        = isBlocked ? 'Unblock It' : 'Block It';
  confirmBtn.dataset.ctxUnblock = isBlocked ? '1' : '0';
  showModal('ctx-pending');
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function showError(el, msg) {
  el.textContent = msg;
  el.classList.add('visible');
}

function flashButton(id, label) {
  const btn  = document.getElementById(id);
  const orig = btn.textContent;
  btn.textContent = label;
  btn.classList.add('btn-success');
  setTimeout(() => { btn.textContent = orig; btn.classList.remove('btn-success'); }, 1800);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
