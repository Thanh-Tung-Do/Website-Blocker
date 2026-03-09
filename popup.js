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
let selectedDays = new Set([1, 2, 3, 4, 5]);

// Sites tab
let selectedListId = 'default';  // which list is being edited
let sitesRevealed  = false;       // whether the selected list's domains are visible

// Generic password-confirmation
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
  if (!state.hasPassword)     { showModal('setup');  return; }
  if (!state.sessionUnlocked) { showModal('unlock'); return; }
  hideModal();
  renderHeader();
  renderBlockLists();
  renderScheduleTab();
  renderPomodoroTab();
  renderSettingsTab();
  handlePendingContextMenu();
}

// ─────────────────────────────────────────────────────────────
// HEADER — always-block toggle
// ─────────────────────────────────────────────────────────────

function renderHeader() {
  const pill  = document.getElementById('block-pill');
  const label = document.getElementById('block-pill-label');
  const on    = !!state.alwaysBlock;
  pill.classList.toggle('on',  on);
  pill.classList.toggle('off', !on);
  label.textContent = on ? 'Blocking: ON' : 'Blocking: OFF';
}

// ─────────────────────────────────────────────────────────────
// ALWAYS-BLOCK TOGGLE
// Turning ON  → no password needed
// Turning OFF → password required (when requirePasswordToDisable=true)
// ─────────────────────────────────────────────────────────────

function setupBlockToggle() {
  document.getElementById('block-pill').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!state.sessionUnlocked) { showModal('unlock'); return; }

    const newVal = !state.alwaysBlock;

    if (!newVal) {
      // Turning OFF — may require password
      maybeRequirePassword(
        '🔒 Turn Off Blocking',
        'Enter your password to disable always-block mode.',
        () => applyAlwaysBlock(false)
      );
    } else {
      // Turning ON — no password
      await applyAlwaysBlock(true);
    }
  });
}

async function applyAlwaysBlock(newVal) {
  // Optimistic update
  state.alwaysBlock = newVal;
  renderHeader();
  const result = await send({ type: 'SET_ALWAYS_BLOCK', enabled: newVal });
  if (result && result.error) {
    state.alwaysBlock = !newVal;
    renderHeader();
    alert(result.error);
  }
}

// ─────────────────────────────────────────────────────────────
// CONDITIONAL PASSWORD GATE
// When requirePasswordToDisable is true  → show password modal
// When requirePasswordToDisable is false → run callback directly
// ─────────────────────────────────────────────────────────────

function maybeRequirePassword(title, body, callback) {
  if (state.requirePasswordToDisable) {
    confirmWithPassword(title, body, callback);
  } else {
    Promise.resolve().then(callback);
  }
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
// GENERIC PASSWORD CONFIRMATION MODAL
// ─────────────────────────────────────────────────────────────

function confirmWithPassword(title, body, callback) {
  pendingPasswordCallback = callback;
  document.getElementById('reveal-modal-title').textContent = title;
  document.getElementById('reveal-modal-body').textContent  = body;
  document.getElementById('reveal-pw').value = '';
  document.getElementById('reveal-error').classList.remove('visible');
  showModal('reveal');
}

// ─────────────────────────────────────────────────────────────
// SITES TAB — multi-list
// ─────────────────────────────────────────────────────────────

function setupSitesTab() {
  document.getElementById('btn-add-site').addEventListener('click', addSite);
  document.getElementById('site-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') addSite();
  });

  document.getElementById('btn-new-list').addEventListener('click', createNewList);

  document.getElementById('btn-reveal-sites').addEventListener('click', () => {
    confirmWithPassword(
      '🔒 Reveal Blocked Sites',
      'Enter your password to view the domains in this list.',
      () => { sitesRevealed = true; renderSelectedListDomains(); }
    );
  });

  document.getElementById('btn-hide-sites').addEventListener('click', () => {
    sitesRevealed = false;
    renderSelectedListDomains();
  });
}

// Render the list-of-lists cards
function renderBlockLists() {
  const container = document.getElementById('block-lists');
  const lists     = state.blockLists || [];
  container.innerHTML = '';

  lists.forEach(list => {
    const item = document.createElement('div');
    item.className = 'block-list-item' + (list.id === selectedListId ? ' editing' : '');
    item.dataset.id = list.id;

    const domainCount = (list.domains || []).length;
    const isDefault   = list.id === 'default';
    const statusClass = list.enabled ? 'on' : 'off';

    item.innerHTML = `
      <span class="list-dot ${statusClass}"></span>
      <div class="list-info">
        <div class="list-name">${escapeHtml(list.name)}</div>
        <div class="list-meta">${domainCount} domain${domainCount !== 1 ? 's' : ''}${list.enabled ? '' : ' · disabled'}</div>
      </div>
      <div class="list-actions">
        <label class="toggle" style="pointer-events:auto" title="${list.enabled ? 'Disable list' : 'Enable list'}">
          <input type="checkbox" class="list-toggle-chk" data-list-id="${list.id}" ${list.enabled ? 'checked' : ''} />
          <span class="toggle-slider"></span>
        </label>
        <button class="btn-icon-sm" data-action="edit" data-list-id="${list.id}" title="Edit domains">✏️</button>
        ${isDefault ? '' : `<button class="btn-icon-sm danger" data-action="delete" data-list-id="${list.id}" title="Delete list">✕</button>`}
      </div>
    `;

    // List enable/disable toggle
    item.querySelector('.list-toggle-chk').addEventListener('change', (e) => {
      e.stopPropagation();
      const enabling = e.target.checked;
      if (!enabling) {
        // Turning OFF — may require password
        e.target.checked = true; // revert visually until confirmed
        maybeRequirePassword(
          '🔒 Disable List',
          `Enter your password to disable the "${list.name}" list.`,
          async () => {
            const result = await send({ type: 'TOGGLE_LIST', id: list.id, enabled: false });
            if (result.error) { alert(result.error); return; }
            state.blockLists = result.blockLists;
            renderBlockLists();
          }
        );
      } else {
        // Turning ON — no password
        send({ type: 'TOGGLE_LIST', id: list.id, enabled: true }).then(result => {
          if (result.error) { alert(result.error); return; }
          state.blockLists = result.blockLists;
          renderBlockLists();
        });
      }
    });

    // Edit button — select this list for editing
    item.querySelector('[data-action="edit"]').addEventListener('click', () => {
      selectList(list.id);
    });

    // Delete button
    const deleteBtn = item.querySelector('[data-action="delete"]');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', () => {
        maybeRequirePassword(
          '🔒 Delete List',
          `Enter your password to permanently delete "${list.name}" and all its domains.`,
          async () => {
            const result = await send({ type: 'DELETE_LIST', id: list.id });
            if (result.error) { alert(result.error); return; }
            state.blockLists = result.blockLists;
            if (selectedListId === list.id) {
              selectedListId = 'default';
              sitesRevealed  = false;
            }
            renderBlockLists();
            renderListEditSection();
          }
        );
      });
    }

    container.appendChild(item);
  });
}

// Switch which list is selected for editing
function selectList(id) {
  if (selectedListId !== id) sitesRevealed = false; // hide on list change
  selectedListId = id;
  renderBlockLists();
  renderListEditSection();
}

// Show or hide the domain-editing section and update its content
function renderListEditSection() {
  const section  = document.getElementById('selected-list-section');
  const nameEl   = document.getElementById('selected-list-name');
  const addLabel = document.getElementById('adding-to-label');
  const list     = (state.blockLists || []).find(l => l.id === selectedListId);

  if (!list) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';
  nameEl.textContent   = list.name;
  addLabel.textContent = list.name;

  renderSelectedListDomains();
}

// Render the hidden/revealed domain list for the selected list
function renderSelectedListDomains() {
  const hiddenState   = document.getElementById('sites-hidden-state');
  const listContainer = document.getElementById('site-list-container');
  const countText     = document.getElementById('sites-count-text');
  const siteList      = document.getElementById('site-list');
  const emptyMsg      = document.getElementById('site-empty');

  const list    = (state.blockLists || []).find(l => l.id === selectedListId);
  const domains = list ? (list.domains || []) : [];
  const n       = domains.length;

  countText.textContent = n === 0 ? 'No sites yet' : `${n} site${n !== 1 ? 's' : ''}`;

  if (!sitesRevealed) {
    hiddenState.style.display   = 'block';
    listContainer.style.display = 'none';
    return;
  }

  hiddenState.style.display   = 'none';
  listContainer.style.display = 'block';
  siteList.innerHTML = '';

  if (domains.length === 0) {
    emptyMsg.style.display = 'block';
    return;
  }

  emptyMsg.style.display = 'none';
  domains.forEach(domain => {
    const item = document.createElement('div');
    item.className = 'site-item';
    item.innerHTML = `<span title="${escapeHtml(domain)}">${escapeHtml(domain)}</span><button title="Remove">✕</button>`;
    item.querySelector('button').addEventListener('click', () => removeSiteFromList(domain, selectedListId));
    siteList.appendChild(item);
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

  const result = await send({ type: 'ADD_SITE_TO_LIST', domain, listId: selectedListId });
  if (result.error) { alert(result.error); return; }

  input.value     = '';
  state.blockLists = result.blockLists;
  renderBlockLists();
  renderSelectedListDomains();
}

async function removeSiteFromList(domain, listId) {
  if (!state.sessionUnlocked) { showModal('unlock'); return; }

  const result = await send({ type: 'REMOVE_SITE_FROM_LIST', domain, listId });
  if (result.error) { alert(result.error); return; }
  state.blockLists = result.blockLists;
  renderBlockLists();
  renderSelectedListDomains();
}

async function createNewList() {
  if (!state.sessionUnlocked) { showModal('unlock'); return; }

  const name = window.prompt('New list name:', 'My List');
  if (!name || !name.trim()) return;

  const result = await send({ type: 'CREATE_LIST', name: name.trim() });
  if (result.error) { alert(result.error); return; }
  state.blockLists = result.blockLists;
  // Auto-select the new list
  const newList = result.blockLists[result.blockLists.length - 1];
  selectList(newList.id);
  renderBlockLists();
}

function showInlineError(inputId, msg) {
  const input = document.getElementById(inputId);
  input.style.borderColor = 'var(--danger)';
  input.title = msg;
  setTimeout(() => { input.style.borderColor = ''; input.title = ''; }, 2000);
}

// ─────────────────────────────────────────────────────────────
// SCHEDULE TAB — always requires password to save
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
}

function renderScheduleTab() {
  const sched = state.schedule || {};
  document.getElementById('schedule-enabled').checked = !!sched.enabled;
  document.getElementById('schedule-start').value     = sched.startTime || '09:00';
  document.getElementById('schedule-end').value       = sched.endTime   || '17:00';
  selectedDays = new Set(sched.days || [1, 2, 3, 4, 5]);
  document.querySelectorAll('.day-btn').forEach(btn => {
    btn.classList.toggle('selected', selectedDays.has(parseInt(btn.dataset.day)));
  });
}

function saveSchedule() {
  if (!state.sessionUnlocked) { showModal('unlock'); return; }
  const schedule = {
    enabled:   document.getElementById('schedule-enabled').checked,
    startTime: document.getElementById('schedule-start').value,
    endTime:   document.getElementById('schedule-end').value,
    days:      [...selectedDays]
  };
  confirmWithPassword(
    '🔒 Save Schedule',
    'Enter your password to save changes to the blocking schedule.',
    async () => {
      const result = await send({ type: 'UPDATE_SCHEDULE', schedule });
      if (result.error) { alert(result.error); return; }
      state.schedule = schedule;
      flashButton('btn-save-schedule', 'Saved!');
    }
  );
}

// ─────────────────────────────────────────────────────────────
// POMODORO TAB
// Start → no password. Stop → may require password.
// ─────────────────────────────────────────────────────────────

function setupPomodoroTab() {
  document.getElementById('btn-pomo-start').addEventListener('click', startPomodoro);
  document.getElementById('btn-pomo-stop').addEventListener('click',  stopPomodoro);
  document.getElementById('btn-save-pomo').addEventListener('click',  savePomodoroSettings);
}

function renderPomodoroTab() {
  clearInterval(countdownInterval);
  const pomo = state.pomodoro;
  document.getElementById('pomo-work').value   = pomo.settings.workDuration  || 25;
  document.getElementById('pomo-break').value  = pomo.settings.breakDuration || 5;
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
  // Start: no password required
  const result = await send({ type: 'START_POMODORO' });
  if (result.error) { alert(result.error); return; }
  await refreshState();
  renderPomodoroTab();
  renderHeader();
}

function stopPomodoro() {
  if (!state.sessionUnlocked) { showModal('unlock'); return; }
  // Stop: may require password
  maybeRequirePassword(
    '🔒 Stop Pomodoro',
    'Enter your password to stop the current Pomodoro session.',
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
// SETTINGS TAB
// ─────────────────────────────────────────────────────────────

function setupSettingsTab() {
  // Security: require-password-to-disable toggle
  document.getElementById('require-pw-toggle').addEventListener('change', (e) => {
    const newVal = e.target.checked;
    if (!newVal && state.requirePasswordToDisable) {
      // Turning OFF (weakening security) always requires password regardless of the setting
      e.target.checked = true; // revert visually
      confirmWithPassword(
        '🔒 Reduce Security',
        'Enter your password to allow disabling blocking features without re-entering your password.',
        async () => {
          const result = await send({ type: 'SET_REQUIRE_PASSWORD_TO_DISABLE', enabled: false });
          if (result.error) { alert(result.error); return; }
          state.requirePasswordToDisable = false;
          document.getElementById('require-pw-toggle').checked = false;
        }
      );
    } else if (newVal) {
      // Turning ON — no password
      send({ type: 'SET_REQUIRE_PASSWORD_TO_DISABLE', enabled: true }).then(result => {
        if (result.error) { alert(result.error); return; }
        state.requirePasswordToDisable = true;
      });
    }
  });

  document.getElementById('btn-change-pw').addEventListener('click', changePassword);
  document.getElementById('btn-add-quote').addEventListener('click', addCustomQuote);
  document.getElementById('btn-reset').addEventListener('click', () => {
    showConfirm(
      'Reset All Settings?',
      'This permanently erases your blocklist, schedule, password, and all settings. Cannot be undone.',
      async () => {
        await send({ type: 'RESET_ALL' });
        sitesRevealed = false;
        selectedListId = 'default';
        await refreshState();
        renderUI();
      }
    );
  });
}

function renderSettingsTab() {
  document.getElementById('require-pw-toggle').checked = !!state.requirePasswordToDisable;
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

  // ── Setup password (first run) ───────────────────────────────
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
    state.hasPassword = true; state.sessionUnlocked = true;
    await refreshState();
    renderUI();
  });
  ['setup-pw1', 'setup-pw2'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => {
      if (e.key === 'Enter') document.getElementById('btn-setup-submit').click();
    });
  });

  // ── Unlock ──────────────────────────────────────────────────
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
    sitesRevealed = false; selectedListId = 'default';
    await refreshState();
    renderUI();
  });

  // ── Generic confirm ──────────────────────────────────────────
  document.getElementById('btn-confirm-cancel').addEventListener('click', () => {
    confirmCallback = null; hideModal();
  });
  document.getElementById('btn-confirm-ok').addEventListener('click', async () => {
    hideModal();
    if (confirmCallback) { const cb = confirmCallback; confirmCallback = null; await cb(); }
  });

  // ── Password-confirm (reveal + schedule + disable actions) ───
  document.getElementById('btn-reveal-submit').addEventListener('click', async () => {
    const pw  = document.getElementById('reveal-pw').value;
    const err = document.getElementById('reveal-error');
    err.classList.remove('visible');
    if (!pw) { showError(err, 'Enter your password.'); return; }
    const result = await send({ type: 'VERIFY_PASSWORD', password: pw });
    if (result.success) {
      hideModal();
      if (pendingPasswordCallback) {
        const cb = pendingPasswordCallback; pendingPasswordCallback = null;
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

  // ── Context menu pending ─────────────────────────────────────
  document.getElementById('btn-ctx-cancel').addEventListener('click', async () => {
    await send({ type: 'CLEAR_PENDING_CONTEXT_MENU' });
    state.pendingContextMenuDomain = null; hideModal();
  });
  document.getElementById('btn-ctx-confirm').addEventListener('click', async () => {
    const result = await send({ type: 'ADD_PENDING_CONTEXT_MENU_SITE' });
    if (result.error) { alert(result.error); return; }
    state.blockLists = result.blockLists || state.blockLists;
    state.pendingContextMenuDomain = null;
    hideModal();
    renderBlockLists();
    renderListEditSection();
  });
}

// ─────────────────────────────────────────────────────────────
// CONTEXT MENU PENDING
// ─────────────────────────────────────────────────────────────

function handlePendingContextMenu() {
  const pending = state.pendingContextMenuDomain;
  if (!pending) return;
  document.getElementById('ctx-pending-msg').textContent =
    `You right-clicked to block "${pending}". Add it to your Default list?`;
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
