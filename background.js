// background.js — MV3 Service Worker
// Handles: blocking rules, Pomodoro timer, schedule, context menu, master password session.

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
  // Register context menu (remove first to avoid duplicates)
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'blockSite',
      title: 'Block this website',
      contexts: ['all']
    });
  });

  // Ensure schedule checker alarm exists
  const existing = await chrome.alarms.get('schedule_check');
  if (!existing) {
    chrome.alarms.create('schedule_check', { periodInMinutes: 1 });
  }

  // Restore blocking rules based on current state
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

// ─────────────────────────────────────────────────────────────
// BLOCKING LOGIC
// ─────────────────────────────────────────────────────────────

function escapeRegex(str) {
  return str.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

async function isBlockingActive() {
  const session = await getSession(['pomodoroRunning', 'pomodoroPhase']);

  // Pomodoro always wins: work = block, break = unblock (even overrides always-block)
  if (session.pomodoroRunning) {
    return session.pomodoroPhase === 'work';
  }

  // Always-block mode — on by default (undefined === true)
  const { alwaysBlock } = await getLocal('alwaysBlock');
  if (alwaysBlock !== false) return true;

  // alwaysBlock explicitly disabled → fall back to schedule
  return await isScheduleActive();
}

async function isScheduleActive() {
  const { schedule } = await getLocal('schedule');
  if (!schedule || !schedule.enabled) return false;

  const now = new Date();
  const day = now.getDay(); // 0=Sun … 6=Sat

  if (!schedule.days || !schedule.days.includes(day)) return false;

  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const [startH, startM] = schedule.startTime.split(':').map(Number);
  const [endH, endM] = schedule.endTime.split(':').map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  // Handle overnight schedules (e.g. 22:00 → 06:00)
  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  } else {
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }
}

async function updateBlockingRules() {
  const active = await isBlockingActive();
  const { blocklist = [] } = await getLocal('blocklist');

  // Remove all existing dynamic rules first
  const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existingRules.map(r => r.id);

  if (!active || blocklist.length === 0) {
    if (removeRuleIds.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: [] });
    }
    return;
  }

  const extId = chrome.runtime.id;

  const addRules = blocklist.map((domain, index) => ({
    id: index + 1,
    priority: 1,
    action: {
      type: 'redirect',
      redirect: {
        url: `chrome-extension://${extId}/blocked.html?site=${encodeURIComponent(domain)}`
      }
    },
    condition: {
      // Matches domain and all subdomains, not URL query params
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
  const endTime = Date.now() + workDuration * 60 * 1000;

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
  const session = await getSession([
    'pomodoroPhase', 'pomodoroSessionCount', 'pomodoroRunning'
  ]);

  if (!session.pomodoroRunning) return;

  const { pomodoroSettings = {} } = await getLocal('pomodoroSettings');
  const workDuration = pomodoroSettings.workDuration ?? 25;
  const breakDuration = pomodoroSettings.breakDuration ?? 5;

  if (session.pomodoroPhase === 'work') {
    // Work ended → start break
    const sessionCount = (session.pomodoroSessionCount || 0) + 1;
    const breakEndTime = Date.now() + breakDuration * 60 * 1000;

    await chrome.storage.session.set({
      pomodoroPhase: 'break',
      pomodoroEndTime: breakEndTime,
      pomodoroSessionCount: sessionCount
    });

    await chrome.alarms.create('pomodoro_phase_end', { when: breakEndTime });

    chrome.notifications.create(`pomodoro_${Date.now()}`, {
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: '🍅 Pomodoro Complete!',
      message: `Session #${sessionCount} done. Take a ${breakDuration}-minute break — you've earned it!`
    });

  } else if (session.pomodoroPhase === 'break') {
    // Break ended → start next work phase
    const workEndTime = Date.now() + workDuration * 60 * 1000;

    await chrome.storage.session.set({
      pomodoroPhase: 'work',
      pomodoroEndTime: workEndTime
    });

    await chrome.alarms.create('pomodoro_phase_end', { when: workEndTime });

    chrome.notifications.create(`pomodoro_${Date.now()}`, {
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: '⏰ Break Over!',
      message: `Time to focus! Starting your next ${workDuration}-minute work session.`
    });
  }

  await updateBlockingRules();
  await updateBadge();
}

// ─────────────────────────────────────────────────────────────
// MASTER PASSWORD
// ─────────────────────────────────────────────────────────────

async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyPassword(password) {
  // Lockout check
  const session = await getSession(['lockoutUntil', 'failedAttempts']);

  if (session.lockoutUntil && Date.now() < session.lockoutUntil) {
    const remainingMs = session.lockoutUntil - Date.now();
    const remainingMinutes = Math.ceil(remainingMs / 60000);
    return { success: false, locked: true, remainingMinutes };
  }

  const { passwordHash } = await getLocal('passwordHash');
  const hash = await hashPassword(password);

  if (hash === passwordHash) {
    await chrome.storage.session.set({
      sessionUnlocked: true,
      failedAttempts: 0,
      lockoutUntil: null
    });
    return { success: true };
  }

  // Wrong password
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
// BLOCKLIST HELPERS
// ─────────────────────────────────────────────────────────────

async function addSiteToBlocklist(domain) {
  const { blocklist = [] } = await getLocal('blocklist');
  if (blocklist.includes(domain)) return blocklist;
  const newBlocklist = [...blocklist, domain];
  await chrome.storage.local.set({ blocklist: newBlocklist });
  await updateBlockingRules();
  return newBlocklist;
}

async function removeSiteFromBlocklist(domain) {
  const { blocklist = [] } = await getLocal('blocklist');
  const newBlocklist = blocklist.filter(d => d !== domain);
  await chrome.storage.local.set({ blocklist: newBlocklist });
  await updateBlockingRules();
  return newBlocklist;
}

// ─────────────────────────────────────────────────────────────
// CONTEXT MENU
// ─────────────────────────────────────────────────────────────

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'blockSite') return;

  const url = tab && tab.url;
  if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://')) {
    chrome.notifications.create(`ctx_${Date.now()}`, {
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: 'Website Blocker',
      message: 'Cannot block Chrome internal pages.'
    });
    return;
  }

  let domain;
  try {
    domain = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return;
  }

  const unlocked = await isSessionUnlocked();

  if (!unlocked) {
    // Store the pending domain so the popup can pick it up
    await chrome.storage.session.set({ pendingContextMenuDomain: domain });
    chrome.notifications.create(`ctx_lock_${Date.now()}`, {
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: 'Website Blocker — Locked',
      message: `Open the extension popup and unlock to block ${domain}.`
    });
    return;
  }

  await addSiteToBlocklist(domain);

  chrome.notifications.create(`ctx_ok_${Date.now()}`, {
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: 'Website Blocked',
    message: `${domain} has been added to your blocklist.`
  });
});

// ─────────────────────────────────────────────────────────────
// ALARMS
// ─────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'pomodoro_phase_end') {
    await handlePomodoroAlarm();
  } else if (alarm.name === 'schedule_check') {
    // Re-evaluate schedule blocking every minute
    await updateBlockingRules();
  }
});

// ─────────────────────────────────────────────────────────────
// MESSAGE HANDLER  (popup ↔ background)
// ─────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch(err => sendResponse({ error: err.message }));
  return true; // keep channel open for async response
});

async function handleMessage(message) {
  switch (message.type) {

    // ── State snapshot ───────────────────────────────────────
    case 'GET_STATE': {
      const session = await getSession([
        'pomodoroRunning', 'pomodoroPhase', 'pomodoroEndTime',
        'pomodoroSessionCount', 'sessionUnlocked', 'lockoutUntil',
        'failedAttempts', 'pendingContextMenuDomain'
      ]);
      const local = await getLocal([
        'blocklist', 'schedule', 'pomodoroSettings',
        'passwordHash', 'customQuotes', 'alwaysBlock'
      ]);

      return {
        pomodoro: {
          running: !!session.pomodoroRunning,
          phase: session.pomodoroPhase || 'idle',
          endTime: session.pomodoroEndTime || null,
          sessionCount: session.pomodoroSessionCount || 0,
          settings: local.pomodoroSettings || { workDuration: 25, breakDuration: 5 }
        },
        blocklist: local.blocklist || [],
        schedule: local.schedule || {
          enabled: false,
          startTime: '09:00',
          endTime: '17:00',
          days: [1, 2, 3, 4, 5]
        },
        customQuotes: local.customQuotes || [],
        hasPassword: !!local.passwordHash,
        sessionUnlocked: !!session.sessionUnlocked,
        lockoutUntil: session.lockoutUntil || null,
        failedAttempts: session.failedAttempts || 0,
        pendingContextMenuDomain: session.pendingContextMenuDomain || null,
        // alwaysBlock defaults to true when not explicitly set
        alwaysBlock: local.alwaysBlock !== false,
        blockingActive: await isBlockingActive()
      };
    }

    // ── Password setup (first run) ───────────────────────────
    case 'SETUP_PASSWORD': {
      const hash = await hashPassword(message.password);
      await chrome.storage.local.set({ passwordHash: hash });
      await chrome.storage.session.set({ sessionUnlocked: true, failedAttempts: 0, lockoutUntil: null });
      return { success: true };
    }

    // ── Verify / unlock ─────────────────────────────────────
    case 'VERIFY_PASSWORD': {
      return await verifyPassword(message.password);
    }

    // ── Manual lock ──────────────────────────────────────────
    case 'LOCK_SESSION': {
      await chrome.storage.session.set({ sessionUnlocked: false });
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

    // ── Blocklist ────────────────────────────────────────────
    case 'ADD_SITE': {
      if (!await isSessionUnlocked()) return { error: 'Session locked' };
      const blocklist = await addSiteToBlocklist(message.domain);
      return { success: true, blocklist };
    }

    case 'REMOVE_SITE': {
      if (!await isSessionUnlocked()) return { error: 'Session locked' };
      const blocklist = await removeSiteFromBlocklist(message.domain);
      return { success: true, blocklist };
    }

    // ── Schedule ─────────────────────────────────────────────
    case 'UPDATE_SCHEDULE': {
      if (!await isSessionUnlocked()) return { error: 'Session locked' };
      await chrome.storage.local.set({ schedule: message.schedule });
      await updateBlockingRules();
      return { success: true };
    }

    // ── Custom quotes ────────────────────────────────────────
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

    // ── Always-block toggle ──────────────────────────────────
    case 'SET_ALWAYS_BLOCK': {
      if (!await isSessionUnlocked()) return { error: 'Session locked' };
      await chrome.storage.local.set({ alwaysBlock: message.enabled });
      await updateBlockingRules();
      await updateBadge();
      return { success: true };
    }

    // ── Password change (requires current password) ──────────
    case 'CHANGE_PASSWORD': {
      if (!await isSessionUnlocked()) return { error: 'Session locked' };
      // Verify the current password before allowing the change
      const verify = await verifyPassword(message.currentPassword);
      if (!verify.success) {
        if (verify.locked) {
          return { error: `Too many attempts. Try again in ${verify.remainingMinutes} minute(s).` };
        }
        return { error: `Current password is incorrect. ${verify.attemptsRemaining} attempt(s) remaining.` };
      }
      const hash = await hashPassword(message.newPassword);
      await chrome.storage.local.set({ passwordHash: hash });
      return { success: true };
    }

    // ── Context menu: clear pending domain ───────────────────
    case 'CLEAR_PENDING_CONTEXT_MENU': {
      await chrome.storage.session.remove('pendingContextMenuDomain');
      return { success: true };
    }

    // ── Add pending context menu domain ──────────────────────
    case 'ADD_PENDING_CONTEXT_MENU_SITE': {
      if (!await isSessionUnlocked()) return { error: 'Session locked' };
      const { pendingContextMenuDomain } = await getSession('pendingContextMenuDomain');
      if (!pendingContextMenuDomain) return { success: false };
      const blocklist = await addSiteToBlocklist(pendingContextMenuDomain);
      await chrome.storage.session.remove('pendingContextMenuDomain');

      chrome.notifications.create(`ctx_ok_${Date.now()}`, {
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'Website Blocked',
        message: `${pendingContextMenuDomain} has been added to your blocklist.`
      });
      return { success: true, blocklist };
    }

    // ── Full reset ───────────────────────────────────────────
    case 'RESET_ALL': {
      await chrome.storage.local.clear();
      await chrome.storage.session.clear();
      await chrome.alarms.clear('pomodoro_phase_end');
      const existing = await chrome.declarativeNetRequest.getDynamicRules();
      if (existing.length > 0) {
        await chrome.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: existing.map(r => r.id),
          addRules: []
        });
      }
      await chrome.action.setBadgeText({ text: '' });
      return { success: true };
    }

    default:
      return { error: `Unknown message type: ${message.type}` };
  }
}
