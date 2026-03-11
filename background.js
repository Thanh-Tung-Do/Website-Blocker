// background.js — MV3 Service Worker
// Handles: blocking rules, Pomodoro timer, schedule, Hard Mode, password, context menu.

// ─────────────────────────────────────────────────────────────
// INITIALISATION
// ─────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => { await initExtension(); });
chrome.runtime.onStartup.addListener(async () => { await initExtension(); });

async function initExtension() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'blockSite', title: 'Block this website', contexts: ['all'] });
  });

  const existing = await chrome.alarms.get('schedule_check');
  if (!existing) chrome.alarms.create('schedule_check', { periodInMinutes: 1 });

  await migrateSchedule();

  const { hardModeUntil } = await getLocal('hardModeUntil');
  if (hardModeUntil && Date.now() < hardModeUntil) {
    const existingHm = await chrome.alarms.get('hard_mode_end');
    if (!existingHm) await chrome.alarms.create('hard_mode_end', { when: hardModeUntil });
  }

  await updateBlockingRules();
  await updateBadge();
}

async function migrateSchedule() {
  const { schedule, schedules } = await getLocal(['schedule', 'schedules']);
  if (schedules !== undefined) return;
  const migrated = schedule ? [{ ...schedule, id: Date.now(), name: 'My Schedule' }] : [];
  await chrome.storage.local.set({ schedules: migrated });
  if (schedule) await chrome.storage.local.remove('schedule');
}

// ─────────────────────────────────────────────────────────────
// STORAGE HELPERS
// ─────────────────────────────────────────────────────────────

async function getLocal(keys) { return chrome.storage.local.get(keys); }
async function getSession(keys) { return chrome.storage.session.get(keys); }

// ─────────────────────────────────────────────────────────────
// CRYPTO HELPERS
// ─────────────────────────────────────────────────────────────

const PBKDF2_ITERATIONS = 200_000;
const PEEK_RULE_ID      = 9999;

function hexToBytes(hex) {
  return new Uint8Array(hex.match(/.{2}/g).map(b => parseInt(b, 16)));
}
function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function generateSalt() {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}
async function deriveKey(password, salt) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), { name: 'PBKDF2' }, false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: hexToBytes(salt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    true, ['encrypt', 'decrypt']
  );
}
async function hashKey(key) {
  const raw = await crypto.subtle.exportKey('raw', key);
  const digest = await crypto.subtle.digest('SHA-256', raw);
  return bytesToHex(new Uint8Array(digest));
}
async function keyToHex(key) {
  const raw = await crypto.subtle.exportKey('raw', key);
  return bytesToHex(new Uint8Array(raw));
}
async function hexToKey(hex) {
  return crypto.subtle.importKey('raw', hexToBytes(hex), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
async function encryptJSON(value, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(value))
  );
  return { iv: bytesToHex(iv), data: bytesToHex(new Uint8Array(ciphertext)) };
}
async function decryptJSON(iv, data, key) {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: hexToBytes(iv) }, key, hexToBytes(data)
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}
async function legacyHash(password) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password));
  return bytesToHex(new Uint8Array(digest));
}

// ─────────────────────────────────────────────────────────────
// BLOCK LISTS — encrypted storage
// ─────────────────────────────────────────────────────────────

// In-memory cache — avoids re-decrypting on every tab switch / context menu update.
// Cleared on session lock or service worker restart (both are fine — will re-decrypt once).
let _blockListsCache = null;

// Returns [{id, name, sites[]}] or null if session locked / decryption fails.
async function getDecryptedBlockLists() {
  if (_blockListsCache !== null) return _blockListsCache;
  const { sessionEncKey } = await getSession('sessionEncKey');
  if (!sessionEncKey) return null;
  const { blockListsEncrypted, blockListsIV } = await getLocal(['blockListsEncrypted', 'blockListsIV']);
  if (!blockListsEncrypted || !blockListsIV) { _blockListsCache = []; return []; }
  try {
    const key = await hexToKey(sessionEncKey);
    _blockListsCache = await decryptJSON(blockListsIV, blockListsEncrypted, key);
    return _blockListsCache;
  } catch { return null; }
}

// Encrypts and saves block lists array. Also refreshes blocking rules.
async function saveBlockLists(lists, key) {
  _blockListsCache = lists; // update cache immediately so next read is instant
  const { iv, data } = await encryptJSON(lists, key);
  await chrome.storage.local.set({ blockListsEncrypted: data, blockListsIV: iv });
  await updateBlockingRules();
}

// Returns unique domains from the specified lists. listIds may include '__all__'.
function getDomainsFromLists(lists, listIds) {
  const useAll = listIds.includes('__all__');
  const selected = useAll ? lists : lists.filter(l => listIds.includes(l.id));
  const domains = new Set();
  selected.forEach(l => (l.sites || []).forEach(d => domains.add(d)));
  return [...domains];
}

// Returns true if domain is in any block list.
function isDomainBlocked(lists, domain) {
  return lists.some(l => (l.sites || []).includes(domain));
}

// ─────────────────────────────────────────────────────────────
// BLOCKING LOGIC
// ─────────────────────────────────────────────────────────────

function escapeRegex(str) { return str.replace(/[.+?^${}()|[\]\\]/g, '\\$&'); }

// Returns {active: bool, listIds: string[]} for the currently active blocking mode.
async function getActiveBlockState() {
  const { hardModeUntil } = await getLocal('hardModeUntil');
  if (hardModeUntil && Date.now() < hardModeUntil) {
    const { alwaysBlockLists = ['__all__'] } = await getLocal('alwaysBlockLists');
    return { active: true, listIds: alwaysBlockLists };
  }

  const session = await getSession(['pomodoroRunning', 'pomodoroPhase']);
  if (session.pomodoroRunning) {
    if (session.pomodoroPhase !== 'work') return { active: false, listIds: [] };
    const { pomodoroSettings = {} } = await getLocal('pomodoroSettings');
    return { active: true, listIds: pomodoroSettings.lists || ['__all__'] };
  }

  const { alwaysBlock, alwaysBlockLists = ['__all__'] } = await getLocal(['alwaysBlock', 'alwaysBlockLists']);
  if (alwaysBlock !== false) return { active: true, listIds: alwaysBlockLists };

  // Fall through to schedules
  const { schedules = [] } = await getLocal('schedules');
  const now = new Date();
  const day = now.getDay();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  for (const schedule of schedules) {
    if (!schedule.enabled) continue;
    if (!schedule.days || !schedule.days.includes(day)) continue;
    const [startH, startM] = schedule.startTime.split(':').map(Number);
    const [endH,   endM]   = schedule.endTime.split(':').map(Number);
    const startMin = startH * 60 + startM;
    const endMin   = endH   * 60 + endM;
    const inWindow = startMin <= endMin
      ? currentMinutes >= startMin && currentMinutes < endMin
      : currentMinutes >= startMin || currentMinutes < endMin;
    if (inWindow) return { active: true, listIds: schedule.lists || ['__all__'] };
  }
  return { active: false, listIds: [] };
}

async function isBlockingActive() {
  const { active } = await getActiveBlockState();
  return active;
}

// Redirects open tabs for `domain` only if it is covered by the currently active mode.
// Pass the updated lists (after the add) so the check reflects the new state.
async function redirectIfActivelyBlocked(domain, lists) {
  const { active, listIds } = await getActiveBlockState();
  if (!active) return;
  const { showPrivateLists = false } = await getLocal('showPrivateLists');
  const domainSet = new Set(getDomainsFromLists(lists, listIds));
  if (!showPrivateLists) {
    lists.filter(l => l.isPrivate).forEach(l => (l.sites || []).forEach(d => domainSet.add(d)));
  }
  if (domainSet.has(domain)) await redirectBlockedTabs([domain]);
}

// Returns the domains that should be blocked right now (mode-aware).
async function getActiveDomainsForRedirect() {
  const { active, listIds } = await getActiveBlockState();
  if (!active) return [];
  const lists = await getDecryptedBlockLists();
  if (!lists) return [];
  const domains = new Set(getDomainsFromLists(lists, listIds));
  const { showPrivateLists = false } = await getLocal('showPrivateLists');
  if (!showPrivateLists) {
    lists.filter(l => l.isPrivate).forEach(l => (l.sites || []).forEach(d => domains.add(d)));
  }
  return [...domains];
}

async function updateBlockingRules() {
  const { active, listIds } = await getActiveBlockState();
  const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existingRules.map(r => r.id);

  if (!active) {
    if (removeRuleIds.length > 0)
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: [] });
    return;
  }

  const lists = await getDecryptedBlockLists();
  if (lists === null) return; // session locked — leave existing rules unchanged

  const { showPrivateLists = false } = await getLocal('showPrivateLists');
  const domainSet = new Set(getDomainsFromLists(lists, listIds));
  if (!showPrivateLists) {
    lists.filter(l => l.isPrivate).forEach(l => (l.sites || []).forEach(d => domainSet.add(d)));
  }
  const domains = [...domainSet];
  if (domains.length === 0) {
    if (removeRuleIds.length > 0)
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: [] });
    return;
  }

  const extId = chrome.runtime.id;
  const addRules = domains.map((domain, index) => ({
    id: index + 1,
    priority: 1,
    action: { type: 'redirect', redirect: { url: `chrome-extension://${extId}/blocked.html?site=${encodeURIComponent(domain)}` } },
    condition: { regexFilter: `^https?://(?:[^/?#]*\\.)?${escapeRegex(domain)}(?:[/?#].*)?$`, resourceTypes: ['main_frame'] }
  }));

  // Re-include peek allow rule if active
  const { peekDomain, peekUntil } = await getSession(['peekDomain', 'peekUntil']);
  if (peekDomain && peekUntil && Date.now() < peekUntil) {
    addRules.push({
      id: PEEK_RULE_ID,
      priority: 2,
      action: { type: 'allow' },
      condition: { regexFilter: `^https?://(?:[^/?#]*\\.)?${escapeRegex(peekDomain)}(?:[/?#].*)?$`, resourceTypes: ['main_frame'] }
    });
  }

  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
}

async function redirectBlockedTabs(domains) {
  if (!domains || domains.length === 0) return;
  const extId = chrome.runtime.id;
  const blockedPrefix = `chrome-extension://${extId}/blocked.html`;
  let tabs;
  try { tabs = await chrome.tabs.query({}); } catch { return; }
  for (const tab of tabs) {
    if (!tab.url) continue;
    if (tab.url.startsWith(blockedPrefix) || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) continue;
    for (const domain of domains) {
      const regex = new RegExp(`^https?://(?:[^/?#]*\\.)?${escapeRegex(domain)}(?:[/?#].*)?$`, 'i');
      if (regex.test(tab.url)) {
        try { await chrome.tabs.update(tab.id, { url: `${blockedPrefix}?site=${encodeURIComponent(domain)}` }); } catch {}
        break;
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// BADGE
// ─────────────────────────────────────────────────────────────

async function updateBadge() {
  const { hardModeUntil } = await getLocal('hardModeUntil');
  if (hardModeUntil && Date.now() < hardModeUntil) {
    await chrome.action.setBadgeText({ text: 'HM' });
    await chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
    return;
  }
  const session = await getSession(['pomodoroRunning', 'pomodoroPhase']);
  if (session.pomodoroRunning) {
    if (session.pomodoroPhase === 'work') {
      await chrome.action.setBadgeText({ text: 'W' });
      await chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
    } else {
      await chrome.action.setBadgeText({ text: 'B' });
      await chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
    }
  } else {
    await chrome.action.setBadgeText({ text: '' });
  }
}

// ─────────────────────────────────────────────────────────────
// POMODORO
// ─────────────────────────────────────────────────────────────

async function startPomodoro() {
  const { pomodoroSettings = {} } = await getLocal('pomodoroSettings');
  const workDuration = pomodoroSettings.workDuration ?? 25;
  const endTime = Date.now() + workDuration * 60 * 1000;
  await chrome.storage.session.set({ pomodoroRunning: true, pomodoroPhase: 'work', pomodoroEndTime: endTime, pomodoroSessionCount: 0 });
  await chrome.alarms.clear('pomodoro_phase_end');
  await chrome.alarms.create('pomodoro_phase_end', { when: endTime });
  await updateBlockingRules();
  await updateBadge();
  await redirectBlockedTabs(await getActiveDomainsForRedirect());
}

async function stopPomodoro() {
  await chrome.storage.session.set({ pomodoroRunning: false, pomodoroPhase: 'idle', pomodoroEndTime: null });
  await chrome.alarms.clear('pomodoro_phase_end');
  await updateBlockingRules();
  await updateBadge();
}

async function handlePomodoroAlarm() {
  const session = await getSession(['pomodoroPhase', 'pomodoroSessionCount', 'pomodoroRunning']);
  if (!session.pomodoroRunning) return;
  const { pomodoroSettings = {} } = await getLocal('pomodoroSettings');
  const workDuration = pomodoroSettings.workDuration ?? 25;
  const breakDuration = pomodoroSettings.breakDuration ?? 5;

  if (session.pomodoroPhase === 'work') {
    const sessionCount = (session.pomodoroSessionCount || 0) + 1;
    const breakEndTime = Date.now() + breakDuration * 60 * 1000;
    await chrome.storage.session.set({ pomodoroPhase: 'break', pomodoroEndTime: breakEndTime, pomodoroSessionCount: sessionCount });
    await chrome.alarms.create('pomodoro_phase_end', { when: breakEndTime });
    chrome.notifications.create(`pomodoro_${Date.now()}`, { type: 'basic', iconUrl: 'icons/icon48.png', title: '🍅 Pomodoro Complete!', message: `Session #${sessionCount} done. Take a ${breakDuration}-minute break!` });
  } else if (session.pomodoroPhase === 'break') {
    const workEndTime = Date.now() + workDuration * 60 * 1000;
    await chrome.storage.session.set({ pomodoroPhase: 'work', pomodoroEndTime: workEndTime });
    await chrome.alarms.create('pomodoro_phase_end', { when: workEndTime });
    chrome.notifications.create(`pomodoro_${Date.now()}`, { type: 'basic', iconUrl: 'icons/icon48.png', title: '⏰ Break Over!', message: `Time to focus! Starting your next ${workDuration}-minute session.` });
  }

  await updateBlockingRules();
  await updateBadge();
  const updatedSession = await getSession('pomodoroPhase');
  if (updatedSession.pomodoroPhase === 'work') {
    await redirectBlockedTabs(await getActiveDomainsForRedirect());
  }
}

// ─────────────────────────────────────────────────────────────
// MASTER PASSWORD
// ─────────────────────────────────────────────────────────────

async function verifyPassword(password) {
  const session = await getSession(['lockoutUntil', 'failedAttempts']);
  if (session.lockoutUntil && Date.now() < session.lockoutUntil) {
    const remainingMinutes = Math.ceil((session.lockoutUntil - Date.now()) / 60000);
    return { success: false, locked: true, remainingMinutes };
  }

  const { passwordHash, passwordSalt } = await getLocal(['passwordHash', 'passwordSalt']);
  let key = null;
  let verified = false;

  if (!passwordSalt) {
    // Legacy unsalted SHA-256 path
    const hash = await legacyHash(password);
    if (hash === passwordHash) {
      verified = true;
      const salt = await generateSalt();
      key = await deriveKey(password, salt);
      const newHash = await hashKey(key);
      // Migrate old flat blocklist to new multi-list format
      const { blocklist: legacyList = [] } = await getLocal('blocklist');
      const updates = { passwordHash: newHash, passwordSalt: salt };
      if (legacyList.length > 0) {
        const defaultList = [{ id: `list_${Date.now()}`, name: 'Default', sites: legacyList }];
        const { iv, data } = await encryptJSON(defaultList, key);
        updates.blockListsEncrypted = data;
        updates.blockListsIV = iv;
      }
      await chrome.storage.local.set(updates);
      if (legacyList.length > 0) await chrome.storage.local.remove('blocklist');
    }
  } else {
    key = await deriveKey(password, passwordSalt);
    verified = (await hashKey(key)) === passwordHash;
  }

  if (verified) {
    const keyHex = await keyToHex(key);
    await chrome.storage.session.set({ sessionUnlocked: true, failedAttempts: 0, lockoutUntil: null, sessionEncKey: keyHex });

    // Migrate old single-blob blocklistEncrypted → new blockListsEncrypted format
    const { blocklistEncrypted, blocklistIV, blockListsEncrypted: newFmt } =
      await getLocal(['blocklistEncrypted', 'blocklistIV', 'blockListsEncrypted']);
    if (blocklistEncrypted && blocklistIV && !newFmt) {
      try {
        const oldList = await decryptJSON(blocklistIV, blocklistEncrypted, key);
        const defaultList = [{ id: `list_${Date.now()}`, name: 'Default', sites: oldList }];
        const { iv, data } = await encryptJSON(defaultList, key);
        await chrome.storage.local.set({ blockListsEncrypted: data, blockListsIV: iv });
        await chrome.storage.local.remove(['blocklistEncrypted', 'blocklistIV']);
      } catch { /* start fresh */ }
    }

    refreshCtxMenuForActiveTab();
    return { success: true };
  }

  const attempts = (session.failedAttempts || 0) + 1;
  if (attempts >= 5) {
    const lockoutUntil = Date.now() + 10 * 60 * 1000;
    await chrome.storage.session.set({ failedAttempts: attempts, lockoutUntil });
    return { success: false, locked: true, remainingMinutes: 10 };
  }
  await chrome.storage.session.set({ failedAttempts: attempts });
  return { success: false, attemptsRemaining: 5 - attempts };
}

async function isSessionUnlocked() {
  const { sessionUnlocked } = await getSession('sessionUnlocked');
  return !!sessionUnlocked;
}

// ─────────────────────────────────────────────────────────────
// CONTEXT MENU
// ─────────────────────────────────────────────────────────────

// Track currently-created submenu item IDs (in-memory; reset on SW restart)
let _ctxSubmenuIds = [];

async function _removeCtxSubmenu() {
  for (const id of _ctxSubmenuIds) {
    try { await chrome.contextMenus.remove(id); } catch {}
  }
  _ctxSubmenuIds = [];
}

async function _buildCtxSubmenu(lists) {
  await _removeCtxSubmenu();
  const { showPrivateLists = false } = await getLocal('showPrivateLists');
  const visibleLists = showPrivateLists ? lists : lists.filter(l => !l.isPrivate);
  for (const list of visibleLists) {
    const id = `blockToList_${list.id}`;
    try {
      chrome.contextMenus.create({ id, parentId: 'blockSite', title: list.name, contexts: ['all'] });
      _ctxSubmenuIds.push(id);
    } catch {}
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const menuItemId = info.menuItemId;
  const isSubmenuClick = typeof menuItemId === 'string' && menuItemId.startsWith('blockToList_');
  if (menuItemId !== 'blockSite' && !isSubmenuClick) return;

  const url = tab && tab.url;
  if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://')) {
    chrome.notifications.create(`ctx_${Date.now()}`, { type: 'basic', iconUrl: 'icons/icon48.png', title: 'Website Blocker', message: 'Cannot block Chrome internal pages.' });
    return;
  }
  let domain;
  try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch { return; }

  if (!await isSessionUnlocked()) {
    await chrome.storage.session.set({ pendingContextMenuDomain: domain });
    chrome.notifications.create(`ctx_lock_${Date.now()}`, { type: 'basic', iconUrl: 'icons/icon48.png', title: 'Website Blocker — Locked', message: `Open the popup and unlock to block/unblock ${domain}.` });
    return;
  }

  const lists = (await getDecryptedBlockLists()) || [];
  const { sessionEncKey } = await getSession('sessionEncKey');
  const key = await hexToKey(sessionEncKey);

  if (isDomainBlocked(lists, domain)) {
    // Unblock: remove from all lists
    const newLists = lists.map(l => ({ ...l, sites: l.sites.filter(d => d !== domain) }));
    await saveBlockLists(newLists, key);
    chrome.notifications.create(`ctx_unblock_${Date.now()}`, { type: 'basic', iconUrl: 'icons/icon48.png', title: 'Website Unblocked', message: `${domain} removed from all block lists.` });
    await updateContextMenuForTab(tab.id);
  } else if (isSubmenuClick) {
    // Submenu item clicked — block to the specific list
    const targetListId = menuItemId.replace('blockToList_', '');
    const idx = lists.findIndex(l => l.id === targetListId);
    if (idx === -1) return;
    const newLists = [...lists];
    newLists[idx] = { ...newLists[idx], sites: [...(newLists[idx].sites || []), domain] };
    await saveBlockLists(newLists, key);
    await redirectIfActivelyBlocked(domain, newLists);
    chrome.notifications.create(`ctx_ok_${Date.now()}`, { type: 'basic', iconUrl: 'icons/icon48.png', title: 'Website Blocked', message: `"${domain}" added to "${lists[idx].name}".` });
    await updateContextMenuForTab(tab.id);
  } else {
    // Parent item clicked with 0–1 lists: block to first (or create default)
    let workingLists = [...lists];
    if (workingLists.length === 0) workingLists.push({ id: `list_${Date.now()}`, name: 'Default', sites: [] });
    workingLists[0] = { ...workingLists[0], sites: [...(workingLists[0].sites || []), domain] };
    await saveBlockLists(workingLists, key);
    await redirectIfActivelyBlocked(domain, workingLists);
    chrome.notifications.create(`ctx_ok_${Date.now()}`, { type: 'basic', iconUrl: 'icons/icon48.png', title: 'Website Blocked', message: `"${domain}" added to "${workingLists[0].name}".` });
    await updateContextMenuForTab(tab.id);
  }
});

async function updateContextMenuForTab(tabId) {
  let domain = null;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      chrome.contextMenus.update('blockSite', { title: 'Block this website' });
      await _removeCtxSubmenu();
      return;
    }
    domain = new URL(tab.url).hostname.replace(/^www\./, '');
  } catch { return; }

  const lists = await getDecryptedBlockLists();
  if (lists === null) {
    chrome.contextMenus.update('blockSite', { title: 'Block this website' });
    await _removeCtxSubmenu();
    return;
  }

  const isBlocked = isDomainBlocked(lists, domain);
  chrome.contextMenus.update('blockSite', { title: isBlocked ? 'Unblock this website' : 'Block this website' });

  const { showPrivateLists = false } = await getLocal('showPrivateLists');
  const visibleLists = showPrivateLists ? lists : lists.filter(l => !l.isPrivate);
  if (!isBlocked && visibleLists.length >= 2) {
    await _buildCtxSubmenu(lists);
  } else {
    await _removeCtxSubmenu();
  }
}

function refreshCtxMenuForActiveTab() {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (tab) updateContextMenuForTab(tab.id);
  });
}

chrome.tabs.onActivated.addListener(async (activeInfo) => { await updateContextMenuForTab(activeInfo.tabId); });
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab && activeTab.id === tabId) await updateContextMenuForTab(tabId);
  } catch {}
});

// ─────────────────────────────────────────────────────────────
// ALARMS
// ─────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'pomodoro_phase_end') {
    await handlePomodoroAlarm();
  } else if (alarm.name === 'schedule_check') {
    const rulesBefore = await chrome.declarativeNetRequest.getDynamicRules();
    await updateBlockingRules();
    if (rulesBefore.length === 0 && await isBlockingActive()) {
      await redirectBlockedTabs(await getActiveDomainsForRedirect());
    }
  } else if (alarm.name === 'peek_end') {
    const { peekDomain } = await getSession('peekDomain');
    await chrome.storage.session.remove(['peekDomain', 'peekUntil']);
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [PEEK_RULE_ID], addRules: [] });
    if (peekDomain) {
      await redirectBlockedTabs([peekDomain]);
      chrome.notifications.create(`peek_done_${Date.now()}`, { type: 'basic', iconUrl: 'icons/icon48.png', title: '⏰ Peek Over', message: `${peekDomain} is blocked again.` });
    }
  } else if (alarm.name === 'hard_mode_end') {
    await updateBlockingRules();
    await updateBadge();
    chrome.notifications.create(`hm_done_${Date.now()}`, { type: 'basic', iconUrl: 'icons/icon48.png', title: '🔥 Hard Mode Complete!', message: 'Hard Mode has ended. Blocking is back to normal.' });
  }
});

// ─────────────────────────────────────────────────────────────
// MESSAGE HANDLER
// ─────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch(err => sendResponse({ error: err.message }));
  return true;
});

async function handleMessage(message) {
  switch (message.type) {

    case 'GET_STATE': {
      const session = await getSession([
        'pomodoroRunning', 'pomodoroPhase', 'pomodoroEndTime', 'pomodoroSessionCount',
        'sessionUnlocked', 'lockoutUntil', 'failedAttempts', 'pendingContextMenuDomain',
        'peekDomain', 'peekUntil'
      ]);
      const local = await getLocal([
        'schedules', 'pomodoroSettings', 'passwordHash', 'customQuotes',
        'alwaysBlock', 'hardModeUntil', 'alwaysBlockLists', 'showPrivateLists', 'useBuiltInQuotes'
      ]);
      let blockLists = (await getDecryptedBlockLists()) || [];
      // Auto-create Default list for existing users who have none
      if (blockLists.length === 0 && session.sessionUnlocked) {
        const { sessionEncKey } = await getSession('sessionEncKey');
        if (sessionEncKey) {
          const key = await hexToKey(sessionEncKey);
          blockLists = [{ id: `list_${Date.now()}`, name: 'Default', sites: [] }];
          const { iv, data } = await encryptJSON(blockLists, key);
          await chrome.storage.local.set({ blockListsEncrypted: data, blockListsIV: iv });
        }
      }
      return {
        pomodoro: {
          running: !!session.pomodoroRunning,
          phase: session.pomodoroPhase || 'idle',
          endTime: session.pomodoroEndTime || null,
          sessionCount: session.pomodoroSessionCount || 0,
          settings: local.pomodoroSettings || { workDuration: 25, breakDuration: 5, lists: ['__all__'] }
        },
        blockLists,
        schedules: local.schedules || [],
        customQuotes: local.customQuotes || [],
        useBuiltInQuotes: local.useBuiltInQuotes !== false,
        hasPassword: !!local.passwordHash,
        sessionUnlocked: !!session.sessionUnlocked,
        lockoutUntil: session.lockoutUntil || null,
        failedAttempts: session.failedAttempts || 0,
        pendingContextMenuDomain: session.pendingContextMenuDomain || null,
        alwaysBlock: local.alwaysBlock !== false,
        alwaysBlockLists: local.alwaysBlockLists || ['__all__'],
        blockingActive: await isBlockingActive(),
        hardModeUntil: (local.hardModeUntil && Date.now() < local.hardModeUntil) ? local.hardModeUntil : null,
        peekDomain: (session.peekDomain && session.peekUntil && Date.now() < session.peekUntil) ? session.peekDomain : null,
        peekUntil: (session.peekUntil && Date.now() < session.peekUntil) ? session.peekUntil : null,
        showPrivateLists: !!local.showPrivateLists
      };
    }

    case 'SETUP_PASSWORD': {
      const salt = await generateSalt();
      const key  = await deriveKey(message.password, salt);
      const hash = await hashKey(key);
      const keyHex = await keyToHex(key);
      // Always create a Default list so new users can add sites immediately
      const defaultList = [{ id: `list_${Date.now()}`, name: 'Default', sites: [] }];
      const { iv, data } = await encryptJSON(defaultList, key);
      await chrome.storage.local.set({ passwordHash: hash, passwordSalt: salt, blockListsEncrypted: data, blockListsIV: iv });
      await chrome.storage.session.set({ sessionUnlocked: true, failedAttempts: 0, lockoutUntil: null, sessionEncKey: keyHex });
      return { success: true };
    }

    case 'VERIFY_PASSWORD': { return await verifyPassword(message.password); }

    case 'LOCK_SESSION': {
      _blockListsCache = null;
      await chrome.storage.session.set({ sessionUnlocked: false });
      await chrome.storage.session.remove('sessionEncKey');
      return { success: true };
    }

    // ── Block List management ────────────────────────────────
    case 'CREATE_LIST': {
      if (!await isSessionUnlocked()) return { error: 'Session locked' };
      const lists = (await getDecryptedBlockLists()) || [];
      const { sessionEncKey } = await getSession('sessionEncKey');
      const key = await hexToKey(sessionEncKey);
      const baseName = (message.name || 'New List').trim();
      const existingNames = lists.map(l => l.name);
      let finalName = baseName;
      if (existingNames.includes(finalName)) {
        let counter = 2;
        while (existingNames.includes(`${baseName} ${counter}`)) counter++;
        finalName = `${baseName} ${counter}`;
      }
      const newList = { id: `list_${Date.now()}`, name: finalName, sites: [], isPrivate: !!message.isPrivate };
      const newLists = [...lists, newList];
      await saveBlockLists(newLists, key);
      refreshCtxMenuForActiveTab();
      return { success: true, blockLists: newLists, newListId: newList.id };
    }

    case 'RENAME_LIST': {
      if (!await isSessionUnlocked()) return { error: 'Session locked' };
      const lists = (await getDecryptedBlockLists()) || [];
      const { sessionEncKey } = await getSession('sessionEncKey');
      const key = await hexToKey(sessionEncKey);
      const newLists = lists.map(l => l.id === message.id ? { ...l, name: message.name } : l);
      await saveBlockLists(newLists, key);
      refreshCtxMenuForActiveTab();
      return { success: true, blockLists: newLists };
    }

    case 'DELETE_LIST': {
      if (!await isSessionUnlocked()) return { error: 'Session locked' };
      const lists = (await getDecryptedBlockLists()) || [];
      const { sessionEncKey } = await getSession('sessionEncKey');
      const key = await hexToKey(sessionEncKey);
      const newLists = lists.filter(l => l.id !== message.id);
      await saveBlockLists(newLists, key);
      // Clean up list references in all mode configs
      const { alwaysBlockLists = ['__all__'], schedules = [], pomodoroSettings = {} } =
        await getLocal(['alwaysBlockLists', 'schedules', 'pomodoroSettings']);
      const cleanIds = ids => { const f = (ids || ['__all__']).filter(id => id !== message.id); return f.length === 0 ? ['__all__'] : f; };
      await chrome.storage.local.set({
        alwaysBlockLists: cleanIds(alwaysBlockLists),
        schedules:        schedules.map(s => ({ ...s, lists: cleanIds(s.lists || ['__all__']) })),
        pomodoroSettings: { ...pomodoroSettings, lists: cleanIds(pomodoroSettings.lists || ['__all__']) }
      });
      refreshCtxMenuForActiveTab();
      return { success: true, blockLists: newLists };
    }

    case 'SET_SHOW_PRIVATE_LISTS': {
      await chrome.storage.local.set({ showPrivateLists: !!message.enabled });

      // When hiding private lists: if only 1 non-private list remains and a mode's
      // listIds is empty [], auto-restore it to ['__all__'] so that single list blocks normally.
      if (!message.enabled) {
        const allLists = (await getDecryptedBlockLists()) || [];
        const visibleCount = allLists.filter(l => !l.isPrivate).length;
        if (visibleCount === 1) {
          const fix = ids => (!ids || ids.length === 0) ? ['__all__'] : ids;
          const { alwaysBlockLists, schedules = [], pomodoroSettings = {} } =
            await getLocal(['alwaysBlockLists', 'schedules', 'pomodoroSettings']);
          await chrome.storage.local.set({
            alwaysBlockLists: fix(alwaysBlockLists),
            schedules:        schedules.map(s => ({ ...s, lists: fix(s.lists) })),
            pomodoroSettings: { ...pomodoroSettings, lists: fix(pomodoroSettings.lists) }
          });
        }
      }

      await updateBlockingRules();
      await updateBadge();
      if (!message.enabled) await redirectBlockedTabs(await getActiveDomainsForRedirect());
      refreshCtxMenuForActiveTab();
      return { success: true };
    }

    case 'TOGGLE_LIST_PRIVACY': {
      if (!await isSessionUnlocked()) return { error: 'Session locked' };
      const lists = (await getDecryptedBlockLists()) || [];
      const { sessionEncKey } = await getSession('sessionEncKey');
      const key = await hexToKey(sessionEncKey);
      const newLists = lists.map(l => l.id === message.id ? { ...l, isPrivate: !!message.isPrivate } : l);
      await saveBlockLists(newLists, key);

      // If making a list private reduces visible lists to 1 and showPrivateLists is off,
      // auto-restore any empty mode listIds to ['__all__'].
      const { showPrivateLists = false } = await getLocal('showPrivateLists');
      if (message.isPrivate && !showPrivateLists) {
        const visibleCount = newLists.filter(l => !l.isPrivate).length;
        if (visibleCount === 1) {
          const fix = ids => (!ids || ids.length === 0) ? ['__all__'] : ids;
          const { alwaysBlockLists, schedules = [], pomodoroSettings = {} } =
            await getLocal(['alwaysBlockLists', 'schedules', 'pomodoroSettings']);
          await chrome.storage.local.set({
            alwaysBlockLists: fix(alwaysBlockLists),
            schedules:        schedules.map(s => ({ ...s, lists: fix(s.lists) })),
            pomodoroSettings: { ...pomodoroSettings, lists: fix(pomodoroSettings.lists) }
          });
        }
      }

      await updateBlockingRules();
      refreshCtxMenuForActiveTab();
      return { success: true, blockLists: newLists };
    }

    case 'ADD_SITE_TO_LIST': {
      if (!await isSessionUnlocked()) return { error: 'Session locked' };
      const domainInput = (message.domain || '').trim().toLowerCase().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
      if (!domainInput || !/^[a-z0-9]([a-z0-9\-\.]*[a-z0-9])?(\.[a-z]{2,})$/.test(domainInput)) {
        return { error: 'Invalid domain format.' };
      }
      message = { ...message, domain: domainInput };
      const lists = (await getDecryptedBlockLists()) || [];
      const { sessionEncKey } = await getSession('sessionEncKey');
      const key = await hexToKey(sessionEncKey);
      const idx = lists.findIndex(l => l.id === message.listId);
      if (idx === -1) return { error: 'List not found' };
      if ((lists[idx].sites || []).includes(message.domain)) return { success: true, blockLists: lists };
      const newLists = lists.map((l, i) => i === idx ? { ...l, sites: [...(l.sites || []), message.domain] } : l);
      await saveBlockLists(newLists, key);
      await redirectIfActivelyBlocked(message.domain, newLists);
      return { success: true, blockLists: newLists };
    }

    case 'REMOVE_SITE_FROM_LIST': {
      if (!await isSessionUnlocked()) return { error: 'Session locked' };
      const lists = (await getDecryptedBlockLists()) || [];
      const { sessionEncKey } = await getSession('sessionEncKey');
      const key = await hexToKey(sessionEncKey);
      const newLists = message.listId === '__all__'
        ? lists.map(l => ({ ...l, sites: (l.sites || []).filter(d => d !== message.domain) }))
        : lists.map(l => l.id === message.listId ? { ...l, sites: (l.sites || []).filter(d => d !== message.domain) } : l);
      await saveBlockLists(newLists, key);
      return { success: true, blockLists: newLists };
    }

    // ── Always-block ─────────────────────────────────────────
    case 'SET_ALWAYS_BLOCK': {
      if (!await isSessionUnlocked()) return { error: 'Session locked' };
      await chrome.storage.local.set({ alwaysBlock: message.enabled });
      await updateBlockingRules();
      await updateBadge();
      if (message.enabled) await redirectBlockedTabs(await getActiveDomainsForRedirect());
      return { success: true };
    }

    case 'SET_ALWAYS_BLOCK_LISTS': {
      if (!await isSessionUnlocked()) return { error: 'Session locked' };
      await chrome.storage.local.set({ alwaysBlockLists: message.listIds });
      await updateBlockingRules();
      if (await isBlockingActive()) await redirectBlockedTabs(await getActiveDomainsForRedirect());
      return { success: true };
    }

    // ── Pomodoro ─────────────────────────────────────────────
    case 'START_POMODORO': {
      if (!await isSessionUnlocked()) return { error: 'Session locked' };
      await startPomodoro();
      return { success: true };
    }
    case 'STOP_POMODORO': {
      if (!await isSessionUnlocked()) return { error: 'Session locked' };
      await stopPomodoro();
      return { success: true };
    }
    case 'UPDATE_POMODORO_SETTINGS': {
      if (!await isSessionUnlocked()) return { error: 'Session locked' };
      await chrome.storage.local.set({ pomodoroSettings: message.settings });
      return { success: true };
    }

    // ── Import / Export ───────────────────────────────────────
    case 'IMPORT_SITES': {
      if (!await isSessionUnlocked()) return { error: 'Session locked' };
      const lists = (await getDecryptedBlockLists()) || [];
      const { sessionEncKey } = await getSession('sessionEncKey');
      const key = await hexToKey(sessionEncKey);
      let workingLists = [...lists];
      let totalAdded = 0;
      const newDomainsForRedirect = [];

      if (message.listImports) {
        // Multi-list import: [{name, domains}]
        for (const { name, domains } of message.listImports) {
          const existingIdx = workingLists.findIndex(l => l.name === name);
          if (existingIdx !== -1) {
            const merged = [...new Set([...workingLists[existingIdx].sites, ...domains])];
            const added  = merged.filter(d => !workingLists[existingIdx].sites.includes(d));
            newDomainsForRedirect.push(...added);
            totalAdded += added.length;
            workingLists[existingIdx] = { ...workingLists[existingIdx], sites: merged };
          } else {
            const uid = `list_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            const newSites = [...new Set(domains)];
            workingLists.push({ id: uid, name, sites: newSites });
            newDomainsForRedirect.push(...newSites);
            totalAdded += newSites.length;
          }
        }
      } else {
        // Single-list import: {domains, listId?}
        const incoming = (message.domains || []).filter(d => d && d.includes('.'));
        let targetIdx = workingLists.findIndex(l => l.id === message.listId);
        if (targetIdx === -1) {
          if (workingLists.length === 0) workingLists.push({ id: `list_${Date.now()}`, name: 'Default', sites: [] });
          targetIdx = 0;
        }
        const existing = workingLists[targetIdx].sites;
        const merged   = [...new Set([...existing, ...incoming])];
        const added    = merged.filter(d => !existing.includes(d));
        newDomainsForRedirect.push(...added);
        totalAdded += added.length;
        workingLists[targetIdx] = { ...workingLists[targetIdx], sites: merged };
      }

      await saveBlockLists(workingLists, key);
      if (newDomainsForRedirect.length > 0) await redirectBlockedTabs(newDomainsForRedirect);
      return { success: true, blockLists: workingLists, added: totalAdded };
    }

    // ── Schedules ─────────────────────────────────────────────
    case 'UPDATE_SCHEDULES': {
      if (!await isSessionUnlocked()) return { error: 'Session locked' };
      await chrome.storage.local.set({ schedules: message.schedules });
      await updateBlockingRules();
      return { success: true };
    }

    // ── Custom quotes ─────────────────────────────────────────
    case 'ADD_CUSTOM_QUOTE': {
      if (!await isSessionUnlocked()) return { error: 'Session locked' };
      const { customQuotes = [] } = await getLocal('customQuotes');
      const updated = [...customQuotes, message.quote];
      await chrome.storage.local.set({ customQuotes: updated });
      return { success: true, customQuotes: updated };
    }
    case 'REMOVE_CUSTOM_QUOTE': {
      if (!await isSessionUnlocked()) return { error: 'Session locked' };
      const { customQuotes = [] } = await getLocal('customQuotes');
      const updated = customQuotes.filter((_, i) => i !== message.index);
      await chrome.storage.local.set({ customQuotes: updated });
      return { success: true, customQuotes: updated };
    }
    case 'EDIT_CUSTOM_QUOTE': {
      if (!await isSessionUnlocked()) return { error: 'Session locked' };
      const { customQuotes = [] } = await getLocal('customQuotes');
      if (message.index < 0 || message.index >= customQuotes.length) return { error: 'Invalid quote index.' };
      const updated = [...customQuotes];
      updated[message.index] = message.quote;
      await chrome.storage.local.set({ customQuotes: updated });
      return { success: true, customQuotes: updated };
    }
    case 'IMPORT_CUSTOM_QUOTES': {
      if (!await isSessionUnlocked()) return { error: 'Session locked' };
      const { customQuotes = [] } = await getLocal('customQuotes');
      const existingTexts = new Set(customQuotes.map(q => q.text.toLowerCase().trim()));
      const incoming = (message.quotes || []).filter(q => q && typeof q.text === 'string' && q.text.trim());
      const toAdd  = incoming.filter(q => !existingTexts.has(q.text.toLowerCase().trim()));
      const updated = [...customQuotes, ...toAdd.map(q => ({ text: q.text.trim(), author: (q.author || 'Unknown').trim() }))];
      await chrome.storage.local.set({ customQuotes: updated });
      return { success: true, customQuotes: updated, added: toAdd.length, skipped: incoming.length - toAdd.length };
    }
    case 'SET_USE_BUILT_IN_QUOTES': {
      await chrome.storage.local.set({ useBuiltInQuotes: !!message.enabled });
      return { success: true };
    }

    // ── Password change ───────────────────────────────────────
    case 'CHANGE_PASSWORD': {
      if (!await isSessionUnlocked()) return { error: 'Session locked' };
      const verify = await verifyPassword(message.currentPassword);
      if (!verify.success) {
        return verify.locked
          ? { error: `Too many attempts. Try again in ${verify.remainingMinutes} minute(s).` }
          : { error: `Current password is incorrect. ${verify.attemptsRemaining} attempt(s) remaining.` };
      }
      const newSalt   = await generateSalt();
      const newKey    = await deriveKey(message.newPassword, newSalt);
      const newHash   = await hashKey(newKey);
      const newKeyHex = await keyToHex(newKey);
      const blockLists = (await getDecryptedBlockLists()) || [];
      const updates = { passwordHash: newHash, passwordSalt: newSalt };
      const { iv, data } = await encryptJSON(blockLists, newKey);
      updates.blockListsEncrypted = data;
      updates.blockListsIV        = iv;
      await chrome.storage.local.set(updates);
      await chrome.storage.session.set({ sessionEncKey: newKeyHex });
      return { success: true };
    }

    // ── Hard Mode ─────────────────────────────────────────────
    case 'START_HARD_MODE': {
      if (!await isSessionUnlocked()) return { error: 'Session locked' };
      const durationMs = message.durationMs;
      if (!durationMs || durationMs < 60000) return { error: 'Minimum duration is 1 minute.' };
      const hardModeUntil = Date.now() + durationMs;
      await chrome.storage.local.set({ hardModeUntil });
      await chrome.alarms.clear('hard_mode_end');
      await chrome.alarms.create('hard_mode_end', { when: hardModeUntil });
      await updateBlockingRules();
      await updateBadge();
      await redirectBlockedTabs(await getActiveDomainsForRedirect());
      return { success: true, hardModeUntil };
    }

    // ── Context menu pending ──────────────────────────────────
    case 'CLEAR_PENDING_CONTEXT_MENU': {
      await chrome.storage.session.remove('pendingContextMenuDomain');
      return { success: true };
    }

    case 'REMOVE_PENDING_CONTEXT_MENU_SITE': {
      if (!await isSessionUnlocked()) return { error: 'Session locked' };
      const { pendingContextMenuDomain } = await getSession('pendingContextMenuDomain');
      if (!pendingContextMenuDomain) return { success: false };
      const lists = (await getDecryptedBlockLists()) || [];
      const { sessionEncKey } = await getSession('sessionEncKey');
      const key = await hexToKey(sessionEncKey);
      const newLists = lists.map(l => ({ ...l, sites: (l.sites || []).filter(d => d !== pendingContextMenuDomain) }));
      await saveBlockLists(newLists, key);
      await chrome.storage.session.remove('pendingContextMenuDomain');
      return { success: true, blockLists: newLists };
    }

    case 'ADD_PENDING_CONTEXT_MENU_SITE': {
      if (!await isSessionUnlocked()) return { error: 'Session locked' };
      const { pendingContextMenuDomain } = await getSession('pendingContextMenuDomain');
      if (!pendingContextMenuDomain) return { success: false };
      const lists = (await getDecryptedBlockLists()) || [];
      const { sessionEncKey } = await getSession('sessionEncKey');
      const key = await hexToKey(sessionEncKey);
      let workingLists = [...lists];
      if (workingLists.length === 0) workingLists.push({ id: `list_${Date.now()}`, name: 'Default', sites: [] });
      // Use the list chosen by the user, or fall back to the first list
      let targetIdx = message.listId ? workingLists.findIndex(l => l.id === message.listId) : 0;
      if (targetIdx === -1) targetIdx = 0;
      if (!(workingLists[targetIdx].sites || []).includes(pendingContextMenuDomain)) {
        workingLists[targetIdx] = { ...workingLists[targetIdx], sites: [...(workingLists[targetIdx].sites || []), pendingContextMenuDomain] };
      }
      await saveBlockLists(workingLists, key);
      await redirectIfActivelyBlocked(pendingContextMenuDomain, workingLists);
      await chrome.storage.session.remove('pendingContextMenuDomain');
      chrome.notifications.create(`ctx_ok_${Date.now()}`, { type: 'basic', iconUrl: 'icons/icon48.png', title: 'Website Blocked', message: `${pendingContextMenuDomain} added to "${workingLists[targetIdx].name}".` });
      return { success: true, blockLists: workingLists };
    }

    // ── Peek ──────────────────────────────────────────────────
    case 'PEEK_SITE': {
      const { hardModeUntil } = await getLocal('hardModeUntil');
      if (hardModeUntil && Date.now() < hardModeUntil) return { error: 'Hard Mode is active — peeking is not allowed.' };
      const verify = await verifyPassword(message.password);
      if (!verify.success) return verify;
      const domain     = message.domain;
      const durationMs = Math.min(Math.max(message.durationMs || 300000, 60000), 15 * 60 * 1000);
      const peekUntil  = Date.now() + durationMs;
      const minutes    = Math.round(durationMs / 60000);
      await chrome.storage.session.set({ peekDomain: domain, peekUntil });
      await chrome.alarms.clear('peek_end');
      await chrome.alarms.create('peek_end', { when: peekUntil });
      await updateBlockingRules();
      chrome.notifications.create(`peek_start_${Date.now()}`, { type: 'basic', iconUrl: 'icons/icon48.png', title: '👁 Peek Active', message: `${domain} accessible for ${minutes} min${minutes !== 1 ? 's' : ''}. Auto-blocked after.` });
      return { success: true, peekUntil };
    }

    // ── Full reset ────────────────────────────────────────────
    case 'RESET_ALL': {
      await chrome.storage.local.clear();
      await chrome.storage.session.clear();
      await chrome.alarms.clear('pomodoro_phase_end');
      await chrome.alarms.clear('hard_mode_end');
      await chrome.alarms.clear('peek_end');
      const existing = await chrome.declarativeNetRequest.getDynamicRules();
      if (existing.length > 0) await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: existing.map(r => r.id), addRules: [] });
      await chrome.action.setBadgeText({ text: '' });
      return { success: true };
    }

    default:
      return { error: `Unknown message type: ${message.type}` };
  }
}
