// background.js — MV3 Service Worker
// Handles: blocking rules, multiple block lists, Pomodoro timer,
// schedule, context menu, master password session.

// ─────────────────────────────────────────────────────────────
// INITIALISATION
// ─────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  await initExtension();
});

chrome.runtime.onStartup.addListener(async () => {
  await initExtension();
});

async function initExtension() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'blockSite',
      title: 'Block this website',
      contexts: ['all']
    });
  });

  const existing = await chrome.alarms.get('schedule_check');
  if (!existing) {
    chrome.alarms.create('schedule_check', { periodInMinutes: 1 });
  }

  // Migrate legacy flat blocklist → blockLists if needed
  await getBlockLists();

  await updateBlockingRules();
  await updateBadge();
}

// ─────────────────────────────────────────────────────────────
// STORAGE HELPERS
// ─────────────────────────────────────────────────────────────

async function getLocal(keys) {
  return chrome.storage.local.get(keys);
}

async function getSession(keys) {
  return chrome.storage.session.get(keys);
}

// Lazy-migrating accessor for blockLists.
// Converts the old flat `blocklist` array the first time it's called.
async function getBlockLists() {
  const data = await getLocal(['blockLists', 'blocklist']);
  if (data.blockLists) return data.blockLists;

  // First-run or migration from legacy flat list
  const lists = [{
    id: 'default',
    name: 'Default',
    enabled: true,
    domains: data.blocklist || []
  }];
  await chrome.storage.local.set({ blockLists: lists });
  if (data.blocklist) await chrome.storage.local.remove('blocklist');
  return lists;
}

// Effective domains = union of all enabled lists
function effectiveDomains(blockLists) {
  return [...new Set(
    blockLists
      .filter(l => l.enabled)
      .flatMap(l => l.domains || [])
  )];
}

// ─────────────────────────────────────────────────────────────
// BLOCKING LOGIC
// ─────────────────────────────────────────────────────────────

function escapeRegex(str) {
  return str.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

async function isBlockingActive() {
  const session = await getSession(['pomodoroRunning', 'pomodoroPhase']);

  // Pomodoro always wins: work = block, break = unblock
  if (session.pomodoroRunning) {
    return session.pomodoroPhase === 'work';
  }

  // Always-block mode (default true when not explicitly set)
  const { alwaysBlock } = await getLocal('alwaysBlock');
  if (alwaysBlock !== false) return true;

  // Fallback to schedule
  return await isScheduleActive();
}

async function isScheduleActive() {
  const { schedule } = await getLocal('schedule');
  if (!schedule || !schedule.enabled) return false;

  const now = new Date();
  const day = now.getDay();
  if (!schedule.days || !schedule.days.includes(day)) return false;

  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const [startH, startM] = schedule.startTime.split(':').map(Number);
  const [endH, endM]     = schedule.endTime.split(':').map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes   = endH * 60 + endM;

  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  } else {
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }
}

async function updateBlockingRules() {
  const active     = await isBlockingActive();
  const blockLists = await getBlockLists();
  const domains    = effectiveDomains(blockLists);

  const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existingRules.map(r => r.id);

  if (!active || domains.length === 0) {
    if (removeRuleIds.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: [] });
    }
    return;
  }

  const extId    = chrome.runtime.id;
  const addRules = domains.map((domain, index) => ({
    id: index + 1,
    priority: 1,
    action: {
      type: 'redirect',
      redirect: { url: `chrome-extension://${extId}/blocked.html?site=${encodeURIComponent(domain)}` }
    },
    condition: {
      regexFilter: `^https?://(?:[^/?#]*\\.)?${escapeRegex(domain)}(?:[/?#].*)?$`,
      resourceTypes: ['main_frame']
    }
  }));

  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
}

// ─────────────────────────────────────────────────────────────
// BADGE
// ─────────────────────────────────────────────────────────────

async function updateBadge() {
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
// POMODORO TIMER
// ─────────────────────────────────────────────────────────────

async function startPomodoro() {
  const { pomodoroSettings = {} } = await getLocal('pomodoroSettings');
  const workDuration = pomodoroSettings.workDuration ?? 25;
  const endTime      = Date.now() + workDuration * 60 * 1000;

  await chrome.storage.session.set({
    pomodoroRunning: true,
    pomodoroPhase: 'work',
    pomodoroEndTime: endTime,
    pomodoroSessionCount: 0
  });

  await chrome.alarms.clear('pomodoro_phase_end');
  await chrome.alarms.create('pomodoro_phase_end', { when: endTime });
  await updateBlockingRules();
  await updateBadge();
}

async function stopPomodoro() {
  await chrome.storage.session.set({
    pomodoroRunning: false,
    pomodoroPhase: 'idle',
    pomodoroEndTime: null
  });
  await chrome.alarms.clear('pomodoro_phase_end');
  await updateBlockingRules();
  await updateBadge();
}

async function handlePomodoroAlarm() {
  const session = await getSession(['pomodoroPhase', 'pomodoroSessionCount', 'pomodoroRunning']);
  if (!session.pomodoroRunning) return;

  const { pomodoroSettings = {} } = await getLocal('pomodoroSettings');
  const workDuration  = pomodoroSettings.workDuration  ?? 25;
  const breakDuration = pomodoroSettings.breakDuration ?? 5;

  if (session.pomodoroPhase === 'work') {
    const sessionCount  = (session.pomodoroSessionCount || 0) + 1;
    const breakEndTime  = Date.now() + breakDuration * 60 * 1000;

    await chrome.storage.session.set({
      pomodoroPhase: 'break',
      pomodoroEndTime: breakEndTime,
      pomodoroSessionCount: sessionCount
    });
    await chrome.alarms.create('pomodoro_phase_end', { when: breakEndTime });

    chrome.notifications.create(`pomo_${Date.now()}`, {
      type: 'basic', iconUrl: 'icons/icon48.png',
      title: '🍅 Pomodoro Complete!',
      message: `Session #${sessionCount} done. Take a ${breakDuration}-minute break!`
    });

  } else if (session.pomodoroPhase === 'break') {
    const workEndTime = Date.now() + workDuration * 60 * 1000;

    await chrome.storage.session.set({
      pomodoroPhase: 'work',
      pomodoroEndTime: workEndTime
    });
    await chrome.alarms.create('pomodoro_phase_end', { when: workEndTime });

    chrome.notifications.create(`pomo_${Date.now()}`, {
      type: 'basic', iconUrl: 'icons/icon48.png',
      title: '⏰ Break Over!',
      message: `Time to focus! Starting your next ${workDuration}-minute session.`
    });
  }

  await updateBlockingRules();
  await updateBadge();
}

// ─────────────────────────────────────────────────────────────
// MASTER PASSWORD
// ─────────────────────────────────────────────────────────────

async function hashPassword(password) {
  const encoder   = new TextEncoder();
  const data      = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyPassword(password) {
  const session = await getSession(['lockoutUntil', 'failedAttempts']);

  if (session.lockoutUntil && Date.now() < session.lockoutUntil) {
    const remainingMinutes = Math.ceil((session.lockoutUntil - Date.now()) / 60000);
    return { success: false, locked: true, remainingMinutes };
  }

  const { passwordHash } = await getLocal('passwordHash');
  const hash = await hashPassword(password);

  if (hash === passwordHash) {
    await chrome.storage.session.set({ sessionUnlocked: true, failedAttempts: 0, lockoutUntil: null });
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

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'blockSite') return;

  const url = tab && tab.url;
  if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://')) {
    chrome.notifications.create(`ctx_${Date.now()}`, {
      type: 'basic', iconUrl: 'icons/icon48.png',
      title: 'Website Blocker',
      message: 'Cannot block Chrome internal pages.'
    });
    return;
  }

  let domain;
  try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch { return; }

  if (!await isSessionUnlocked()) {
    await chrome.storage.session.set({ pendingContextMenuDomain: domain });
    chrome.notifications.create(`ctx_lock_${Date.now()}`, {
      type: 'basic', iconUrl: 'icons/icon48.png',
      title: 'Website Blocker — Locked',
      message: `Open the extension popup and unlock to block ${domain}.`
    });
    return;
  }

  await addDomainToDefaultList(domain);
  chrome.notifications.create(`ctx_ok_${Date.now()}`, {
    type: 'basic', iconUrl: 'icons/icon48.png',
    title: 'Website Blocked',
    message: `${domain} has been added to your Default list.`
  });
});

// Adds a domain to the Default list (used by context menu)
async function addDomainToDefaultList(domain) {
  const blockLists = await getBlockLists();
  const updated = blockLists.map(l => {
    if (l.id !== 'default') return l;
    if (l.domains.includes(domain)) return l;
    return { ...l, domains: [...l.domains, domain] };
  });
  await chrome.storage.local.set({ blockLists: updated });
  await updateBlockingRules();
  return updated;
}

// ─────────────────────────────────────────────────────────────
// ALARMS
// ─────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'pomodoro_phase_end') await handlePomodoroAlarm();
  else if (alarm.name === 'schedule_check') await updateBlockingRules();
});

// ─────────────────────────────────────────────────────────────
// MESSAGE HANDLER
// ─────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch(err => sendResponse({ error: err.message }));
  return true;
});

async function handleMessage(message) {
  switch (message.type) {

    // ── Full state snapshot ───────────────────────────────────
    case 'GET_STATE': {
      const session = await getSession([
        'pomodoroRunning', 'pomodoroPhase', 'pomodoroEndTime',
        'pomodoroSessionCount', 'sessionUnlocked', 'lockoutUntil',
        'failedAttempts', 'pendingContextMenuDomain'
      ]);
      const local = await getLocal([
        'schedule', 'pomodoroSettings', 'passwordHash',
        'customQuotes', 'alwaysBlock', 'requirePasswordToDisable'
      ]);
      const blockLists = await getBlockLists();

      return {
        pomodoro: {
          running:  !!session.pomodoroRunning,
          phase:    session.pomodoroPhase || 'idle',
          endTime:  session.pomodoroEndTime  || null,
          sessionCount: session.pomodoroSessionCount || 0,
          settings: local.pomodoroSettings  || { workDuration: 25, breakDuration: 5 }
        },
        blockLists,
        schedule: local.schedule || { enabled: false, startTime: '09:00', endTime: '17:00', days: [1,2,3,4,5] },
        customQuotes: local.customQuotes || [],
        hasPassword:  !!local.passwordHash,
        sessionUnlocked: !!session.sessionUnlocked,
        lockoutUntil:    session.lockoutUntil   || null,
        failedAttempts:  session.failedAttempts || 0,
        pendingContextMenuDomain: session.pendingContextMenuDomain || null,
        alwaysBlock: local.alwaysBlock !== false,            // default true
        requirePasswordToDisable: local.requirePasswordToDisable !== false, // default true
        blockingActive: await isBlockingActive()
      };
    }

    // ── Password setup (first run) ────────────────────────────
    case 'SETUP_PASSWORD': {
      const hash = await hashPassword(message.password);
      await chrome.storage.local.set({ passwordHash: hash });
      await chrome.storage.session.set({ sessionUnlocked: true, failedAttempts: 0, lockoutUntil: null });
      return { success: true };
    }

    // ── Verify password / unlock ──────────────────────────────
    case 'VERIFY_PASSWORD': {
      return await verifyPassword(message.password);
    }

    // ── Manual lock ───────────────────────────────────────────
    case 'LOCK_SESSION': {
      await chrome.storage.session.set({ sessionUnlocked: false });
      return { success: true };
    }

    // ── Always-block toggle ───────────────────────────────────
    case 'SET_ALWAYS_BLOCK': {
      if (!await isSessionUnlocked()) return { error: 'Session locked' };
      await chrome.storage.local.set({ alwaysBlock: message.enabled });
      await updateBlockingRules();
      await updateBadge();
      return { success: true };
    }

    // ── Require-password-to-disable setting ───────────────────
    case 'SET_REQUIRE_PASSWORD_TO_DISABLE': {
      if (!await isSessionUnlocked()) return { error: 'Session locked' };
      await chrome.storage.local.set({ requirePasswordToDisable: message.enabled });
      return { success: true };
    }

    // ── Pomodoro ──────────────────────────────────────────────
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

    // ── Schedule ──────────────────────────────────────────────
    case 'UPDATE_SCHEDULE': {
      if (!await isSessionUnlocked()) return { error: 'Session locked' };
      await chrome.storage.local.set({ schedule: message.schedule });
      await updateBlockingRules();
      return { success: true };
    }

    // ── Block Lists ───────────────────────────────────────────
    case 'CREATE_LIST': {
      if (!await isSessionUnlocked()) return { error: 'Session locked' };
      const blockLists = await getBlockLists();
      const newList = { id: `list_${Date.now()}`, name: message.name, enabled: true, domains: [] };
      const updated = [...blockLists, newList];
      await chrome.storage.local.set({ blockLists: updated });
      await updateBlockingRules();
      return { success: true, blockLists: updated };
    }

    case 'DELETE_LIST': {
      if (!await isSessionUnlocked()) return { error: 'Session locked' };
      if (message.id === 'default') return { error: 'Cannot delete the Default list.' };
      const blockLists = await getBlockLists();
      const updated = blockLists.filter(l => l.id !== message.id);
      await chrome.storage.local.set({ blockLists: updated });
      await updateBlockingRules();
      return { success: true, blockLists: updated };
    }

    case 'RENAME_LIST': {
      if (!await isSessionUnlocked()) return { error: 'Session locked' };
      const blockLists = await getBlockLists();
      const updated = blockLists.map(l => l.id === message.id ? { ...l, name: message.name } : l);
      await chrome.storage.local.set({ blockLists: updated });
      return { success: true, blockLists: updated };
    }

    case 'TOGGLE_LIST': {
      if (!await isSessionUnlocked()) return { error: 'Session locked' };
      const blockLists = await getBlockLists();
      const updated = blockLists.map(l =>
        l.id === message.id ? { ...l, enabled: message.enabled } : l
      );
      await chrome.storage.local.set({ blockLists: updated });
      await updateBlockingRules();
      return { success: true, blockLists: updated };
    }

    case 'ADD_SITE_TO_LIST': {
      if (!await isSessionUnlocked()) return { error: 'Session locked' };
      const blockLists = await getBlockLists();
      const updated = blockLists.map(l => {
        if (l.id !== message.listId) return l;
        if ((l.domains || []).includes(message.domain)) return l;
        return { ...l, domains: [...(l.domains || []), message.domain] };
      });
      await chrome.storage.local.set({ blockLists: updated });
      await updateBlockingRules();
      return { success: true, blockLists: updated };
    }

    case 'REMOVE_SITE_FROM_LIST': {
      if (!await isSessionUnlocked()) return { error: 'Session locked' };
      const blockLists = await getBlockLists();
      const updated = blockLists.map(l => {
        if (l.id !== message.listId) return l;
        return { ...l, domains: (l.domains || []).filter(d => d !== message.domain) };
      });
      await chrome.storage.local.set({ blockLists: updated });
      await updateBlockingRules();
      return { success: true, blockLists: updated };
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

    // ── Password change ───────────────────────────────────────
    case 'CHANGE_PASSWORD': {
      if (!await isSessionUnlocked()) return { error: 'Session locked' };
      const verify = await verifyPassword(message.currentPassword);
      if (!verify.success) {
        if (verify.locked) return { error: `Too many attempts. Try again in ${verify.remainingMinutes} minute(s).` };
        return { error: `Current password is incorrect. ${verify.attemptsRemaining} attempt(s) remaining.` };
      }
      const hash = await hashPassword(message.newPassword);
      await chrome.storage.local.set({ passwordHash: hash });
      return { success: true };
    }

    // ── Context menu helpers ──────────────────────────────────
    case 'CLEAR_PENDING_CONTEXT_MENU': {
      await chrome.storage.session.remove('pendingContextMenuDomain');
      return { success: true };
    }

    case 'ADD_PENDING_CONTEXT_MENU_SITE': {
      if (!await isSessionUnlocked()) return { error: 'Session locked' };
      const { pendingContextMenuDomain } = await getSession('pendingContextMenuDomain');
      if (!pendingContextMenuDomain) return { success: false };
      const blockLists = await addDomainToDefaultList(pendingContextMenuDomain);
      await chrome.storage.session.remove('pendingContextMenuDomain');
      chrome.notifications.create(`ctx_ok_${Date.now()}`, {
        type: 'basic', iconUrl: 'icons/icon48.png',
        title: 'Website Blocked',
        message: `${pendingContextMenuDomain} added to your Default list.`
      });
      return { success: true, blockLists };
    }

    // ── Full reset ────────────────────────────────────────────
    case 'RESET_ALL': {
      await chrome.storage.local.clear();
      await chrome.storage.session.clear();
      await chrome.alarms.clear('pomodoro_phase_end');
      const existing = await chrome.declarativeNetRequest.getDynamicRules();
      if (existing.length > 0) {
        await chrome.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: existing.map(r => r.id), addRules: []
        });
      }
      await chrome.action.setBadgeText({ text: '' });
      return { success: true };
    }

    default:
      return { error: `Unknown message type: ${message.type}` };
  }
}
