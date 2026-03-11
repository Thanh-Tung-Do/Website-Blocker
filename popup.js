// popup.js — Popup UI logic

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
let editingScheduleId = null;
let sitesRevealed = false;
let pendingPasswordCallback = null;

// Currently selected list ID in Sites tab (null = "All Lists" aggregate view)
let currentListId = null;

// Per-mode list selections (saved when forms are submitted)
let scheduleListIds  = ['__all__'];
let pomodoroListIds  = ['__all__'];
let hardModeListIds  = ['__all__'];

// Returns only lists that should be visible in the UI (hides private lists when showPrivateLists is false)
function visibleLists() {
  const lists = state ? (state.blockLists || []) : [];
  if (state && state.showPrivateLists) return lists;
  return lists.filter(l => !l.isPrivate);
}

// Returns true if the given listIds array effectively covers at least one list.
// When private lists are hidden they auto-block regardless of mode listIds,
// so an empty selection is still "effective" if private lists exist.
function hasEffectiveLists(listIds) {
  if (listIds.length > 0) return true;
  if (!state.showPrivateLists && (state.blockLists || []).some(l => l.isPrivate)) return true;
  return false;
}

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
  setupAlwaysBlockTab();
  setupHardModeTab();
  renderUI();
});

async function refreshState() {
  state = await send({ type: 'GET_STATE' });
}

// ─────────────────────────────────────────────────────────────
// RENDER ROUTER
// ─────────────────────────────────────────────────────────────

function renderUI() {
  if (!state.hasPassword) { showModal('setup'); return; }
  if (!state.sessionUnlocked) { showModal('unlock'); return; }
  hideModal();
  renderHeader();
  renderListManagement();
  renderSitesList();
  renderAlwaysBlockTab();
  renderScheduleTab();
  renderPomodoroTab();
  renderSettingsTab();
  handlePendingContextMenu();
}

// ─────────────────────────────────────────────────────────────
// HEADER — always-block toggle
// ─────────────────────────────────────────────────────────────

function renderHeader() {
  const badge      = document.getElementById('block-status-badge');
  const hardBadge  = document.getElementById('hard-badge');
  const on         = !!state.alwaysBlock;
  const hardActive = !!(state.hardModeUntil && Date.now() < state.hardModeUntil);

  hardBadge.classList.toggle('visible', hardActive);
  badge.textContent = on ? 'Always Block: ON' : 'Always Block: OFF';
  badge.classList.toggle('on', on);
  badge.classList.toggle('off', !on);
}

// ─────────────────────────────────────────────────────────────
// ALWAYS BLOCK TAB
// ─────────────────────────────────────────────────────────────

function setupAlwaysBlockTab() {
  document.getElementById('ab-card').addEventListener('click', async () => {
    if (state.hardModeUntil && Date.now() < state.hardModeUntil) return;
    if (!state.sessionUnlocked) { showModal('unlock'); return; }
    const newVal = !state.alwaysBlock;
    if (newVal && !hasEffectiveLists(state.alwaysBlockLists || ['__all__'])) {
      showAlert('No List Selected', 'Select at least one list before turning on Always Block.', '🚫');
      return;
    }
    if (!newVal) {
      confirmWithPassword(
        '🔒 Disable Always Block',
        'Enter your master password to turn off Always Block mode.',
        async () => {
          state.alwaysBlock = false;
          renderHeader();
          renderAlwaysBlockTab();
          const result = await send({ type: 'SET_ALWAYS_BLOCK', enabled: false });
          if (result && result.error) { state.alwaysBlock = true; renderHeader(); renderAlwaysBlockTab(); showAlert('Error', result.error); }
        },
        'Disable'
      );
      return;
    }
    state.alwaysBlock = true;
    renderHeader();
    renderAlwaysBlockTab();
    const result = await send({ type: 'SET_ALWAYS_BLOCK', enabled: true });
    if (result && result.error) { state.alwaysBlock = false; renderHeader(); renderAlwaysBlockTab(); showAlert('Error', result.error); }
  });
}

function renderAlwaysBlockTab() {
  const on         = !!state.alwaysBlock;
  const hardActive = !!(state.hardModeUntil && Date.now() < state.hardModeUntil);
  const lists      = visibleLists();
  const multiList  = lists.length >= 2;

  const card = document.getElementById('ab-card');
  const sub  = document.getElementById('ab-sub');

  card.classList.toggle('on', on);
  card.style.opacity       = hardActive ? '0.5' : '';
  card.style.pointerEvents = hardActive ? 'none' : '';

  sub.textContent = hardActive
    ? 'Locked while Hard Mode is active.'
    : multiList
      ? (on ? 'Sites in selected lists are blocked at all times.' : 'Always Block is off: blocking only activates on schedule.')
      : (on ? 'Websites in your list are blocked at all times.' : 'Turn on to block websites at all times.');

  const listRow    = document.getElementById('ab-list-row');
  const noListWarn = document.getElementById('ab-no-list-warning');
  const currentIds = state.alwaysBlockLists || ['__all__'];

  listRow.style.display = multiList ? 'flex' : 'none';
  if (multiList) {
    noListWarn.textContent = on
      ? '⚠ No list selected: nothing is being blocked!'
      : '⚠ No list selected: nothing will be blocked!';
    noListWarn.classList.toggle('visible', !hasEffectiveLists(currentIds));

    renderListChips('ab-list-chips', currentIds, ids => {
      // Expand __all__ to full list for comparison
      const expand = arr => (arr.includes('__all__') ? lists.map(l => l.id) : arr);
      const prevSet = new Set(expand(currentIds));
      const nextSet = new Set(expand(ids));
      const isRemoving = [...prevSet].some(id => !nextSet.has(id));

      const apply = async () => {
        state.alwaysBlockLists = ids;
        await send({ type: 'SET_ALWAYS_BLOCK_LISTS', listIds: ids });
        renderAlwaysBlockTab();
      };

      // Password only needed when Always Block is ON and coverage is being reduced
      if (on && isRemoving) {
        confirmWithPassword(
          '🔒 Remove from Block',
          'Enter your master password to unblock a list while Always Block is on.',
          apply,
          'Remove'
        );
      } else {
        apply();
      }
    });
  }

  renderHardModeTab();
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
// LIST CHIP RENDERER (shared by all mode tabs)
// ─────────────────────────────────────────────────────────────

// Renders clickable list-chips into containerId.
// activeListIds: current selection (array of IDs or ['__all__'])
// onChangeFn: called with new listIds array when selection changes
function renderListChips(containerId, activeListIds, onChangeFn) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  const lists = visibleLists();
  // Treat as __all__ if the flag is set OR if every specific list is selected
  const allActive = activeListIds.includes('__all__') ||
    (lists.length > 0 && lists.every(l => activeListIds.includes(l.id)));

  const makeChip = (label, active, onClick) => {
    const chip = document.createElement('span');
    chip.className = `list-chip${active ? ' active' : ''}`;
    chip.textContent = label;
    chip.addEventListener('click', onClick);
    return chip;
  };

  // "All Lists" chip — active when all selected; click again to deselect all
  container.appendChild(makeChip('All Lists', allActive, () => {
    const newIds = allActive ? [] : ['__all__'];
    onChangeFn(newIds);
    renderListChips(containerId, newIds, onChangeFn);
  }));

  lists.forEach(l => {
    // Individual chips light up when allActive OR specifically selected
    const isActive = allActive || activeListIds.includes(l.id);
    container.appendChild(makeChip(l.name, isActive, () => {
      if (allActive) {
        // Deselect this one, keep all others
        const newIds = lists.map(x => x.id).filter(id => id !== l.id);
        const resolved = newIds.length === 0 ? ['__all__'] : newIds;
        onChangeFn(resolved);
        renderListChips(containerId, resolved, onChangeFn);
      } else {
        let newIds = activeListIds.filter(id => id !== '__all__');
        if (isActive) {
          newIds = newIds.filter(id => id !== l.id);
          if (newIds.length === 0) newIds = ['__all__'];
        } else {
          newIds = [...newIds, l.id];
          // If all lists are now selected, collapse to __all__
          if (lists.every(x => newIds.includes(x.id))) newIds = ['__all__'];
        }
        onChangeFn(newIds);
        renderListChips(containerId, newIds, onChangeFn);
      }
    }));
  });
}

// Re-render list chips for all mode tabs (called after lists change)
function refreshAllModeChips() {
  const multiList = visibleLists().length >= 2;
  renderAlwaysBlockTab();
  document.getElementById('sched-list-row').style.display = multiList ? 'flex' : 'none';
  if (multiList) {
    renderListChips('schedule-list-chips', scheduleListIds, ids => {
      scheduleListIds = ids;
      document.getElementById('sched-no-list-warning').classList.toggle('visible', !hasEffectiveLists(ids));
    });
  }
  document.getElementById('pomo-list-row').style.display = multiList ? 'flex' : 'none';
  if (multiList) {
    renderListChips('pomo-list-chips', pomodoroListIds, ids => {
      pomodoroListIds = ids;
      document.getElementById('pomo-no-list-warning').classList.toggle('visible', !hasEffectiveLists(ids));
    });
  }
}

// ─────────────────────────────────────────────────────────────
// SITES TAB — list management
// ─────────────────────────────────────────────────────────────

function setupSitesTab() {
  document.getElementById('btn-add-site').addEventListener('click', addSite);
  document.getElementById('site-input').addEventListener('keydown', e => { if (e.key === 'Enter') addSite(); });
  document.getElementById('btn-export-sites').addEventListener('click', exportBlocklist);
  document.getElementById('btn-import-sites').addEventListener('click', () => {
    document.getElementById('import-textarea').value = '';
    document.getElementById('import-error').classList.remove('visible');
    updateImportListSelector();
    showModal('import');
  });

  document.getElementById('list-selector').addEventListener('change', (e) => {
    currentListId = e.target.value === '__all__' ? null : e.target.value;
    renderListManagement();
    renderSitesList();
  });

  document.getElementById('btn-new-list').addEventListener('click', createList);
  document.getElementById('btn-new-list-single').addEventListener('click', createList);
  document.getElementById('btn-rename-list').addEventListener('click', renameList);
  document.getElementById('btn-toggle-private').addEventListener('click', toggleListPrivacy);
  document.getElementById('btn-delete-list').addEventListener('click', deleteList);

  document.getElementById('btn-reveal-sites').addEventListener('click', () => {
    confirmWithPassword(
      '🔒 Reveal Blocklist',
      'Enter your master password to view your blocked sites.',
      () => { sitesRevealed = true; renderSitesList(); },
      'Show Sites'
    );
  });

  document.getElementById('btn-hide-sites').addEventListener('click', () => {
    sitesRevealed = false;
    renderSitesList();
  });
}

// Syncs the list selector dropdown and related UI to current state.
function renderListManagement() {
  const visible = visibleLists();
  if (currentListId && !visible.find(l => l.id === currentListId)) currentListId = null;
  const multiList = visible.length >= 2;

  // Show/hide list bar based on list count
  document.getElementById('list-bar').style.display = multiList ? 'flex' : 'none';
  // Always show "+ New List" button in single-list row; hide it from list-bar when not multi
  document.getElementById('btn-new-list-single').style.display = multiList ? 'none' : 'inline-flex';

  if (!multiList) {
    // Auto-select the only list so Add is immediately usable
    currentListId = visible.length === 1 ? visible[0].id : null;
  } else {
    // Rebuild selector dropdown
    const selector = document.getElementById('list-selector');
    selector.innerHTML = '<option value="__all__">All Lists</option>';
    visible.forEach(l => {
      const opt = document.createElement('option');
      opt.value = l.id;
      opt.textContent = l.name + ` (${(l.sites || []).length})`;
      selector.appendChild(opt);
    });

    if (currentListId && visible.find(l => l.id === currentListId)) {
      selector.value = currentListId;
    } else {
      currentListId = null;
      selector.value = '__all__';
    }

    const isSpecific = !!currentListId;
    document.getElementById('btn-rename-list').style.display = isSpecific ? 'inline-flex' : 'none';
    document.getElementById('btn-delete-list').style.display = isSpecific ? 'inline-flex' : 'none';
    const togglePrivateBtn = document.getElementById('btn-toggle-private');
    if (isSpecific) {
      const selectedList = (state.blockLists || []).find(l => l.id === currentListId);
      togglePrivateBtn.style.display = 'inline-flex';
      togglePrivateBtn.textContent = selectedList?.isPrivate ? 'Make Public' : 'Make Private';
    } else {
      togglePrivateBtn.style.display = 'none';
    }

  }

  // Add-site input: enabled whenever a specific list is auto-selected or chosen
  const addBtn   = document.getElementById('btn-add-site');
  const addInput = document.getElementById('site-input');
  addBtn.disabled   = !currentListId;
  addInput.disabled = !currentListId;
  if (currentListId) {
    addInput.placeholder = `e.g. reddit.com`;
  } else {
    addInput.placeholder = 'Select a list above to add sites';
  }
}

function createList() {
  document.getElementById('new-list-name').value = '';
  document.getElementById('new-list-private').checked = false;
  document.getElementById('new-list-error').textContent = '';
  showModal('new-list');
}

function renameList() {
  if (!currentListId) return;
  const list = (state.blockLists || []).find(l => l.id === currentListId);
  if (!list) return;
  const name = prompt('New name:', list.name);
  if (!name || !name.trim() || name.trim() === list.name) return;
  confirmWithPassword(
    '🔒 Rename List',
    `Enter your master password to rename "${list.name}" to "${name.trim()}".`,
    async () => {
      const result = await send({ type: 'RENAME_LIST', id: currentListId, name: name.trim() });
      if (result.error) { showAlert('Error', result.error); return; }
      state.blockLists = result.blockLists;
      renderListManagement();
      refreshAllModeChips();
    },
    'Rename'
  );
}

function deleteList() {
  if (!currentListId) return;
  const list = (state.blockLists || []).find(l => l.id === currentListId);
  if (!list) return;
  confirmWithPassword(
    '🔒 Delete List',
    `Enter your master password to permanently delete "${list.name}" and all its sites. This cannot be undone.`,
    async () => {
      const result = await send({ type: 'DELETE_LIST', id: currentListId });
      if (result.error) { showAlert('Error', result.error); return; }
      state.blockLists = result.blockLists;
      currentListId = null;
      renderListManagement();
      renderSitesList();
      refreshAllModeChips();
      updateImportListSelector();
    },
    'Delete'
  );
}

function toggleListPrivacy() {
  if (!currentListId) return;
  const list = (state.blockLists || []).find(l => l.id === currentListId);
  if (!list) return;
  const makingPrivate = !list.isPrivate;
  const title = makingPrivate ? '🔒 Make List Private' : '🔒 Make List Public';
  const body  = makingPrivate
    ? `Enter your password to make "${list.name}" private. It will be hidden everywhere and automatically blocked in all active modes.`
    : `Enter your password to make "${list.name}" a normal list. It will become visible everywhere and behave like any other list.`;
  confirmWithPassword(title, body, async () => {
    const result = await send({ type: 'TOGGLE_LIST_PRIVACY', id: currentListId, isPrivate: makingPrivate });
    if (result.error) { showAlert('Error', result.error); return; }
    state.blockLists = result.blockLists;
    if (makingPrivate && !state.showPrivateLists) currentListId = null;
    renderListManagement();
    renderSitesList();
    refreshAllModeChips();
    updateImportListSelector();
  });
}

async function addSite() {
  if (!state.sessionUnlocked) { showModal('unlock'); return; }
  if (!currentListId) { showInlineError('site-input', 'Select a specific list above'); return; }

  const input = document.getElementById('site-input');
  let domain  = input.value.trim().toLowerCase();
  if (!domain) return;
  try {
    if (domain.includes('://')) domain = new URL(domain).hostname;
    domain = domain.replace(/^www\./, '').split('/')[0];
  } catch {}

  if (!domain || !domain.includes('.')) {
    showInlineError('site-input', 'Enter a valid domain (e.g. reddit.com)');
    return;
  }

  const result = await send({ type: 'ADD_SITE_TO_LIST', listId: currentListId, domain });
  if (result.error) { showAlert('Error', result.error); return; }
  input.value = '';
  state.blockLists = result.blockLists;
  renderSitesList();
  renderListManagement(); // update site count in dropdown
}

function renderSitesList() {
  const hiddenState   = document.getElementById('sites-hidden-state');
  const listContainer = document.getElementById('site-list-container');
  const countText     = document.getElementById('sites-count-text');
  const listEl        = document.getElementById('site-list');
  const empty         = document.getElementById('site-empty');

  countText.textContent = '';

  if (!sitesRevealed) {
    hiddenState.style.display   = 'block';
    listContainer.style.display = 'none';
    return;
  }

  hiddenState.style.display   = 'none';
  listContainer.style.display = 'block';
  listEl.innerHTML = '';

  const revealedLists = visibleLists();

  if (currentListId === null) {
    // Aggregate: visible lists grouped by list name
    if (revealedLists.length === 0) {
      empty.style.display = 'block';
      empty.innerHTML = 'No lists yet.<br/>Click <strong>+ New List</strong> above to get started.';
      return;
    }
    let hasSites = false;
    revealedLists.forEach(l => {
      if (!l.sites || l.sites.length === 0) return;
      hasSites = true;
      const header = document.createElement('div');
      header.className = 'list-group-header';
      header.textContent = l.name + (l.isPrivate ? ' 🔒' : '');
      listEl.appendChild(header);
      l.sites.forEach(domain => listEl.appendChild(createSiteItem(domain, l.id)));
    });
    if (!hasSites) {
      empty.style.display = 'block';
      empty.innerHTML = 'No sites in any list yet.';
    } else {
      empty.style.display = 'none';
    }
  } else {
    // Specific list
    const targetList = revealedLists.find(l => l.id === currentListId) || allLists.find(l => l.id === currentListId);
    if (!targetList || (targetList.sites || []).length === 0) {
      empty.style.display = 'block';
      empty.innerHTML = 'No sites in this list yet.<br/>Add a domain above to get started.';
      return;
    }
    empty.style.display = 'none';
    targetList.sites.forEach(domain => listEl.appendChild(createSiteItem(domain, currentListId)));
  }
}

function createSiteItem(domain, listId) {
  const item = document.createElement('div');
  item.className = 'site-item';
  item.innerHTML = `<span title="${escapeHtml(domain)}">${escapeHtml(domain)}</span><button title="Remove">✕</button>`;
  item.querySelector('button').addEventListener('click', () => removeSite(domain, listId));
  return item;
}

async function removeSite(domain, listId) {
  if (!state.sessionUnlocked) { showModal('unlock'); return; }
  const result = await send({ type: 'REMOVE_SITE_FROM_LIST', domain, listId });
  if (result.error) { showAlert('Error', result.error); return; }
  state.blockLists = result.blockLists;
  renderSitesList();
  renderListManagement();
}

// ─────────────────────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────────────────────

function exportBlocklist() {
  if (!state.sessionUnlocked || !sitesRevealed) {
    confirmWithPassword(
      '🔒 Export Blocklist',
      'Enter your master password to export your blocked sites.',
      async () => {
        state.sessionUnlocked = true;
        await refreshState();
        sitesRevealed = true;
        renderSitesList();
        doExport();
      },
      'Export'
    );
    return;
  }
  doExport();
}

function doExport() {
  const lists = state.blockLists || [];
  const hasSites = lists.some(l => (l.sites || []).length > 0);
  if (!hasSites) { showAlert('Nothing to Export', 'Your block lists are empty.', '📋'); return; }

  let content, filename;
  if (currentListId) {
    // Export single selected list — plain domains
    const targetList = lists.find(l => l.id === currentListId);
    if (!targetList || (targetList.sites || []).length === 0) { showAlert('Nothing to Export', 'This list is empty.', '📋'); return; }
    content  = targetList.sites.join('\n');
    filename = `blocklist-${targetList.name.replace(/\s+/g, '-').toLowerCase()}.txt`;
  } else {
    // Export all lists with # List: headers
    const parts = lists
      .filter(l => (l.sites || []).length > 0)
      .map(l => `# List: ${l.name}\n${l.sites.join('\n')}`);
    content  = parts.join('\n');
    filename = 'blocklist-all.txt';
  }

  const blob = new Blob([content], { type: 'text/plain' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─────────────────────────────────────────────────────────────
// IMPORT
// ─────────────────────────────────────────────────────────────

function updateImportListSelector() {
  const select = document.getElementById('import-list-select');
  if (!select) return;
  const lists = visibleLists();
  select.innerHTML = '';
  if (lists.length === 0) {
    const opt = document.createElement('option');
    opt.value = '__first__'; opt.textContent = 'Default (auto-created)';
    select.appendChild(opt);
  } else {
    lists.forEach(l => {
      const opt = document.createElement('option');
      opt.value = l.id; opt.textContent = l.name;
      select.appendChild(opt);
    });
    if (currentListId && lists.find(l => l.id === currentListId)) select.value = currentListId;
  }
}

// Parses import text. Returns [{name: string|null, domains: string[]}]
// name is null for domains not under a # List: header.
function parseImportText(text) {
  const result = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^#\s*[Ll]ist:\s*(.+)$/);
    if (m) { current = { name: m[1].trim(), domains: [] }; result.push(current); continue; }
    if (line.startsWith('#')) continue;
    let d = line.toLowerCase();
    try { if (d.includes('://')) d = new URL(d).hostname; } catch { continue; }
    d = d.replace(/^www\./, '').split('/')[0];
    if (!d.includes('.') || d.includes(' ') || d.length > 253) continue;
    if (!current) { current = { name: null, domains: [] }; result.push(current); }
    current.domains.push(d);
  }
  return result;
}

async function importBlocklist() {
  if (!state.sessionUnlocked) { showModal('unlock'); return; }
  const text = document.getElementById('import-textarea').value;
  const err  = document.getElementById('import-error');
  err.classList.remove('visible');

  const sections = parseImportText(text);
  if (sections.every(s => s.domains.length === 0)) {
    showError(err, 'No valid domains found. Enter one domain per line.');
    return;
  }

  const hasListHeaders = sections.some(s => s.name !== null);
  let result;

  if (hasListHeaders) {
    // Multi-list: group by named sections, merge ungrouped into first named section
    const listImports = sections.filter(s => s.name !== null && s.domains.length > 0).map(s => ({ name: s.name, domains: s.domains }));
    const ungrouped = sections.filter(s => s.name === null).flatMap(s => s.domains);
    if (ungrouped.length > 0) {
      if (listImports.length > 0) listImports[0].domains = [...new Set([...listImports[0].domains, ...ungrouped])];
      else listImports.push({ name: 'Imported', domains: ungrouped });
    }
    result = await send({ type: 'IMPORT_SITES', listImports });
  } else {
    const listId = document.getElementById('import-list-select')?.value || null;
    const domains = sections.flatMap(s => s.domains);
    result = await send({ type: 'IMPORT_SITES', domains, listId });
  }

  if (result.error) { showError(err, result.error); return; }
  state.blockLists = result.blockLists;
  document.getElementById('import-textarea').value = '';
  hideModal();
  renderListManagement();
  renderSitesList();
  refreshAllModeChips();

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
// SCHEDULE TAB
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
  scheduleListIds   = ['__all__'];
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
  const schedMultiList = visibleLists().length >= 2;
  document.getElementById('sched-list-row').style.display = schedMultiList ? 'flex' : 'none';
  if (schedMultiList) {
    renderListChips('schedule-list-chips', scheduleListIds, ids => {
      scheduleListIds = ids;
      document.getElementById('sched-no-list-warning').classList.toggle('visible', !hasEffectiveLists(ids));
    });
    document.getElementById('sched-no-list-warning').classList.toggle('visible', !hasEffectiveLists(scheduleListIds));
  }
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
      const listStr = (() => {
        const ids = sched.lists || ['__all__'];
        if (ids.includes('__all__')) return 'All Lists';
        const names = ids.map(id => (state.blockLists || []).find(l => l.id === id)?.name).filter(Boolean);
        return names.length > 0 ? names.join(', ') : 'All Lists';
      })();
      const card = document.createElement('div');
      card.className = 'sched-card';
      card.innerHTML = `
        <div class="sched-card-dot ${sched.enabled ? 'on' : 'off'}"></div>
        <div class="sched-card-info">
          <div class="sched-card-name">${escapeHtml(sched.name || 'Schedule')}</div>
          <div class="sched-card-sub">${escapeHtml(sched.startTime)} – ${escapeHtml(sched.endTime)} · ${escapeHtml(dayStr || 'No days')} · ${escapeHtml(listStr)}</div>
        </div>
        <div class="sched-card-btns">
          <button class="edit" title="Edit">✏</button>
          <button class="del"  title="Delete">✕</button>
        </div>`;
      card.querySelector('.edit').addEventListener('click', () => startEditSchedule(sched));
      card.querySelector('.del').addEventListener('click',  () => deleteSchedule(sched.id));
      list.appendChild(card);
    });
  }
  if (!editingScheduleId) resetScheduleForm();
}

function startEditSchedule(sched) {
  editingScheduleId = sched.id;
  scheduleListIds   = sched.lists || ['__all__'];
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
  const schedMultiListEdit = visibleLists().length >= 2;
  document.getElementById('sched-list-row').style.display = schedMultiListEdit ? 'flex' : 'none';
  if (schedMultiListEdit) {
    renderListChips('schedule-list-chips', scheduleListIds, ids => {
      scheduleListIds = ids;
      document.getElementById('sched-no-list-warning').classList.toggle('visible', !hasEffectiveLists(ids));
    });
    document.getElementById('sched-no-list-warning').classList.toggle('visible', !hasEffectiveLists(scheduleListIds));
  }
}

function saveSchedule() {
  if (!state.sessionUnlocked) { showModal('unlock'); return; }
  if (!hasEffectiveLists(scheduleListIds)) { showAlert('No List Selected', 'Select at least one list before saving this schedule.', '📅'); return; }
  const entry = {
    id:        editingScheduleId || Date.now(),
    name:      document.getElementById('schedule-name').value.trim() || 'Schedule',
    enabled:   document.getElementById('schedule-enabled').checked,
    startTime: document.getElementById('schedule-start').value,
    endTime:   document.getElementById('schedule-end').value,
    days:      [...selectedDays],
    lists:     scheduleListIds
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
      if (result.error) { showAlert('Error', result.error); return; }
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
      if (result.error) { showAlert('Error', result.error); return; }
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

  pomodoroListIds = pomo.settings.lists || ['__all__'];
  const pomoMultiList = visibleLists().length >= 2;
  document.getElementById('pomo-list-row').style.display = pomoMultiList ? 'flex' : 'none';
  if (pomoMultiList) {
    renderListChips('pomo-list-chips', pomodoroListIds, ids => {
      pomodoroListIds = ids;
      document.getElementById('pomo-no-list-warning').classList.toggle('visible', !hasEffectiveLists(ids));
    });
    document.getElementById('pomo-no-list-warning').classList.toggle('visible', !hasEffectiveLists(pomodoroListIds));
  }

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
    document.getElementById('pomo-countdown').className   = `pomo-countdown ${pomo.phase === 'work' ? 'work' : 'break'}`;
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
  if (!hasEffectiveLists(pomodoroListIds)) { showAlert('No List Selected', 'Select at least one list before starting a Pomodoro session.', '🍅'); return; }
  const result = await send({ type: 'START_POMODORO' });
  if (result.error) { showAlert('Error', result.error); return; }
  await refreshState();
  renderPomodoroTab();
  renderHeader();
}

async function stopPomodoro() {
  if (!state.sessionUnlocked) { showModal('unlock'); return; }
  confirmWithPassword(
    '🔒 Stop Pomodoro',
    'Enter your master password to stop the current Pomodoro session.',
    async () => {
      const result = await send({ type: 'STOP_POMODORO' });
      if (result.error) { showAlert('Error', result.error); return; }
      await refreshState();
      renderPomodoroTab();
      renderHeader();
    },
    'Stop'
  );
}

async function savePomodoroSettings() {
  if (!state.sessionUnlocked) { showModal('unlock'); return; }
  const settings = {
    workDuration:  Math.max(1, parseInt(document.getElementById('pomo-work').value)  || 25),
    breakDuration: Math.max(1, parseInt(document.getElementById('pomo-break').value) || 5),
    lists: pomodoroListIds
  };
  const result = await send({ type: 'UPDATE_POMODORO_SETTINGS', settings });
  if (result.error) { showAlert('Error', result.error); return; }
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

  // When Hard Mode is active, hide the Always Block card and show only the countdown
  document.getElementById('ab-card').style.display     = hardActive ? 'none' : '';
  if (hardActive) document.getElementById('ab-list-row').style.display = 'none';
  // (when inactive, ab-list-row display is already set correctly by renderAlwaysBlockTab)
  document.getElementById('hard-idle').style.display   = hardActive ? 'none' : 'flex';
  document.getElementById('hard-active').style.display = hardActive ? 'flex' : 'none';

  if (hardActive) {
    function tick() {
      const remaining = Math.max(0, state.hardModeUntil - Date.now());
      const totalSecs = Math.floor(remaining / 1000);
      const h = Math.floor(totalSecs / 3600).toString().padStart(2, '0');
      const m = Math.floor((totalSecs % 3600) / 60).toString().padStart(2, '0');
      const s = (totalSecs % 60).toString().padStart(2, '0');
      document.getElementById('hard-countdown').textContent = `${h}:${m}:${s}`;
      if (remaining <= 0) {
        clearInterval(hardCountdownInterval);
        setTimeout(async () => { await refreshState(); renderAlwaysBlockTab(); renderHeader(); }, 1500);
      }
    }
    tick();
    hardCountdownInterval = setInterval(tick, 500);
  }
}

async function startHardMode() {
  if (!state.sessionUnlocked) { showModal('unlock'); return; }
  const hours   = Math.max(0, parseInt(document.getElementById('hard-hours').value)   || 0);
  const minutes = Math.max(0, parseInt(document.getElementById('hard-minutes').value) || 0);
  const durationMs = (hours * 60 + minutes) * 60 * 1000;
  if (durationMs < 60000) { showAlert('Duration Too Short', 'Set a duration of at least 1 minute.', '⏱'); return; }
  const listIds = state.alwaysBlockLists || ['__all__'];
  if (!hasEffectiveLists(listIds)) { showAlert('No List Selected', 'Select at least one list in Always Block before starting Hard Mode.', '🔥'); return; }
  const total = hours > 0 ? `${hours}h ${minutes}m` : `${minutes} minute${minutes !== 1 ? 's' : ''}`;
  showConfirm(
    '🔥 Start Hard Mode?',
    `Blocking will be locked for ${total}. You will NOT be able to stop it early — no toggles, no password bypass, no exceptions. Are you sure?`,
    async () => {
      const result = await send({ type: 'START_HARD_MODE', durationMs });
      if (result.error) { showAlert('Error', result.error); return; }
      state.hardModeUntil = result.hardModeUntil;
      renderHeader();
      renderAlwaysBlockTab();
    }
  );
}

// ─────────────────────────────────────────────────────────────
// SETTINGS TAB
// ─────────────────────────────────────────────────────────────

function setupSettingsTab() {
  document.getElementById('btn-change-pw').addEventListener('click', changePassword);
  document.getElementById('btn-add-quote').addEventListener('click', addCustomQuote);
  document.getElementById('toggle-show-private').addEventListener('click', async () => {
    if (!state.sessionUnlocked) { showModal('unlock'); return; }
    const newVal = !state.showPrivateLists;
    const apply = async () => {
      const result = await send({ type: 'SET_SHOW_PRIVATE_LISTS', enabled: newVal });
      if (result.error) { showAlert('Error', result.error); return; }
      state.showPrivateLists = newVal;
      renderSettingsTab();
      renderListManagement();
      renderSitesList();
      refreshAllModeChips();
    };
    if (newVal) {
      confirmWithPassword('🔒 Show Private Lists', 'Enter your password to reveal private lists and manage them.', apply);
    } else {
      await apply();
    }
  });
  document.getElementById('btn-reset').addEventListener('click', () => {
    confirmWithPassword(
      '⚠️ Reset All Settings?',
      'Enter your master password to permanently erase your block lists, schedule, password, and all settings. This cannot be undone.',
      async () => {
        await send({ type: 'RESET_ALL' });
        sitesRevealed = false;
        currentListId = null;
        await refreshState();
        renderUI();
      },
      'Reset Everything'
    );
  });
}

function renderSettingsTab() {
  renderCustomQuotes();
  const pill = document.getElementById('toggle-show-private');
  pill.classList.toggle('on', !!state.showPrivateLists);
}

async function changePassword() {
  if (!state.sessionUnlocked) { showModal('unlock'); return; }
  const currentPw = document.getElementById('current-password').value;
  const newPw     = document.getElementById('new-password').value;
  const confirmPw = document.getElementById('confirm-password').value;
  if (!currentPw)          return showAlert('Missing Password', 'Enter your current password.', '🔒');
  if (!newPw)              return showAlert('Missing Password', 'Enter a new password.', '🔒');
  if (newPw.length < 4)   return showAlert('Too Short', 'New password must be at least 4 characters.', '🔒');
  if (newPw !== confirmPw) return showAlert('Mismatch', 'New passwords do not match.', '🔒');
  const result = await send({ type: 'CHANGE_PASSWORD', currentPassword: currentPw, newPassword: newPw });
  if (result.error) { showAlert('Error', result.error); return; }
  document.getElementById('current-password').value = '';
  document.getElementById('new-password').value     = '';
  document.getElementById('confirm-password').value = '';
  flashButton('btn-change-pw', 'Changed!');
}

async function addCustomQuote() {
  if (!state.sessionUnlocked) { showModal('unlock'); return; }
  const text   = document.getElementById('quote-text').value.trim();
  const author = document.getElementById('quote-author').value.trim();
  if (!text) return showAlert('Missing Text', 'Enter a quote.', '💬');
  const result = await send({ type: 'ADD_CUSTOM_QUOTE', quote: { text, author: author || 'Unknown' } });
  if (result.error) { showAlert('Error', result.error); return; }
  state.customQuotes = result.customQuotes;
  document.getElementById('quote-text').value   = '';
  document.getElementById('quote-author').value = '';
  renderCustomQuotes();
}

async function removeCustomQuote(index) {
  if (!state.sessionUnlocked) { showModal('unlock'); return; }
  const result = await send({ type: 'REMOVE_CUSTOM_QUOTE', index });
  if (result.error) { showAlert('Error', result.error); return; }
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
    item.innerHTML = `<div class="quote-item-text"><em>${escapeHtml(q.text)}</em> — ${escapeHtml(q.author)}</div><button title="Remove">✕</button>`;
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
    currentListId = null;
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

function showAlert(title, body, icon = '⚠️') {
  document.getElementById('alert-icon').textContent  = icon;
  document.getElementById('alert-title').textContent = title;
  document.getElementById('alert-body').textContent  = body;
  showModal('alert');
}

function setupModalButtons() {
  // Alert "Got it"
  document.getElementById('btn-alert-ok').addEventListener('click', hideModal);

  // Setup password
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
    document.getElementById(id).addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('btn-setup-submit').click(); });
  });

  // Unlock
  document.getElementById('btn-unlock-submit').addEventListener('click', async () => {
    const pw  = document.getElementById('unlock-pw').value;
    const err = document.getElementById('unlock-error');
    err.classList.remove('visible');
    if (!pw) { showError(err, 'Enter your password.'); return; }
    const result = await send({ type: 'VERIFY_PASSWORD', password: pw });
    if (result.success) {
      document.getElementById('unlock-pw').value = '';
      state.sessionUnlocked = true;
      await refreshState();
      renderUI();
    } else if (result.locked) {
      showError(err, `Too many failed attempts. Try again in ${result.remainingMinutes} minute(s).`);
    } else {
      showError(err, `Incorrect password. ${result.attemptsRemaining} attempt(s) remaining.`);
    }
  });
  document.getElementById('unlock-pw').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('btn-unlock-submit').click(); });
  document.getElementById('btn-unlock-forgot').addEventListener('click', () => showModal('forgot'));

  // Forgot
  document.getElementById('btn-forgot-cancel').addEventListener('click',  () => showModal('unlock'));
  document.getElementById('btn-forgot-confirm').addEventListener('click', async () => {
    await send({ type: 'RESET_ALL' });
    sitesRevealed = false; currentListId = null;
    await refreshState();
    renderUI();
  });

  // Generic confirm
  document.getElementById('btn-confirm-cancel').addEventListener('click', () => { confirmCallback = null; hideModal(); });
  document.getElementById('btn-confirm-ok').addEventListener('click', async () => {
    hideModal();
    if (confirmCallback) { const cb = confirmCallback; confirmCallback = null; await cb(); }
  });

  // Password-confirm modal (reveal + schedule + etc.)
  document.getElementById('btn-reveal-submit').addEventListener('click', async () => {
    const pw  = document.getElementById('reveal-pw').value;
    const err = document.getElementById('reveal-error');
    err.classList.remove('visible');
    if (!pw) { showError(err, 'Enter your password.'); return; }
    const result = await send({ type: 'VERIFY_PASSWORD', password: pw });
    if (result.success) {
      hideModal();
      if (pendingPasswordCallback) { const cb = pendingPasswordCallback; pendingPasswordCallback = null; await cb(); }
    } else if (result.locked) {
      showError(err, `Too many failed attempts. Locked for ${result.remainingMinutes} minute(s).`);
    } else {
      showError(err, `Incorrect password. ${result.attemptsRemaining} attempt(s) remaining.`);
    }
  });
  document.getElementById('reveal-pw').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('btn-reveal-submit').click(); });
  document.getElementById('btn-reveal-cancel').addEventListener('click', () => {
    pendingPasswordCallback = null;
    document.getElementById('reveal-pw').value = '';
    hideModal();
  });

  // Import
  document.getElementById('btn-import-cancel').addEventListener('click', () => {
    document.getElementById('import-textarea').value = '';
    document.getElementById('import-error').classList.remove('visible');
    hideModal();
  });
  document.getElementById('btn-import-submit').addEventListener('click', importBlocklist);

  // New list modal
  document.getElementById('btn-new-list-cancel').addEventListener('click', hideModal);
  document.getElementById('new-list-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('btn-new-list-submit').click();
  });
  document.getElementById('btn-new-list-submit').addEventListener('click', async () => {
    const name = document.getElementById('new-list-name').value.trim();
    const isPrivate = document.getElementById('new-list-private').checked;
    if (!name) { document.getElementById('new-list-error').textContent = 'Please enter a list name.'; return; }
    const result = await send({ type: 'CREATE_LIST', name, isPrivate });
    if (result.error) { document.getElementById('new-list-error').textContent = result.error; return; }
    state.blockLists = result.blockLists;
    currentListId = isPrivate && !state.showPrivateLists ? currentListId : result.newListId;
    hideModal();
    renderListManagement();
    renderSitesList();
    refreshAllModeChips();
    updateImportListSelector();
  });

  // Context menu pending
  document.getElementById('btn-ctx-cancel').addEventListener('click', async () => {
    await send({ type: 'CLEAR_PENDING_CONTEXT_MENU' });
    state.pendingContextMenuDomain = null;
    hideModal();
  });
  document.getElementById('btn-ctx-confirm').addEventListener('click', async () => {
    const btn       = document.getElementById('btn-ctx-confirm');
    const isUnblock = btn.dataset.ctxUnblock === '1';
    const ctxListRow = document.getElementById('ctx-list-row');
    const listId = (!isUnblock && ctxListRow.style.display !== 'none')
      ? document.getElementById('ctx-list-select').value
      : null;
    const result    = await send({ type: isUnblock ? 'REMOVE_PENDING_CONTEXT_MENU_SITE' : 'ADD_PENDING_CONTEXT_MENU_SITE', listId });
    if (result.error) { showAlert('Error', result.error); return; }
    state.blockLists = result.blockLists || state.blockLists;
    state.pendingContextMenuDomain = null;
    hideModal();
    renderListManagement();
    renderSitesList();
    renderHeader();
  });
}

// ─────────────────────────────────────────────────────────────
// CONTEXT MENU PENDING
// ─────────────────────────────────────────────────────────────

function isDomainBlockedLocally(domain) {
  return (state.blockLists || []).some(l => (l.sites || []).includes(domain));
}

function handlePendingContextMenu() {
  const pending = state.pendingContextMenuDomain;
  if (!pending) return;
  const isBlocked = isDomainBlockedLocally(pending);
  const lists     = visibleLists();
  const multiList = lists.length >= 2;

  document.getElementById('ctx-pending-msg').textContent = isBlocked
    ? `You right-clicked "${pending}" which is currently blocked. Remove it from all your block lists?`
    : `You right-clicked to block "${pending}". Add it to your block lists now?`;

  // Show list picker only when blocking (not unblocking) and 2+ lists exist
  const ctxListRow    = document.getElementById('ctx-list-row');
  const ctxListSelect = document.getElementById('ctx-list-select');
  if (!isBlocked && multiList) {
    ctxListSelect.innerHTML = '';
    lists.forEach(l => {
      const opt = document.createElement('option');
      opt.value = l.id;
      opt.textContent = l.name + ` (${(l.sites || []).length})`;
      ctxListSelect.appendChild(opt);
    });
    ctxListRow.style.display = 'block';
  } else {
    ctxListRow.style.display = 'none';
  }

  const confirmBtn = document.getElementById('btn-ctx-confirm');
  confirmBtn.textContent        = isBlocked ? 'Unblock It' : 'Block It';
  confirmBtn.dataset.ctxUnblock = isBlocked ? '1' : '0';
  showModal('ctx-pending');
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function showError(el, msg) { el.textContent = msg; el.classList.add('visible'); }

function flashButton(id, label) {
  const btn  = document.getElementById(id);
  const orig = btn.textContent;
  btn.textContent = label;
  btn.classList.add('btn-success');
  setTimeout(() => { btn.textContent = orig; btn.classList.remove('btn-success'); }, 1800);
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
