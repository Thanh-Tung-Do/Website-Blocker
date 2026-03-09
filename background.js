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

  // Migrate single schedule → schedules array (one-time, idempotent)
  await migrateSchedule();
  // Restore blocking rules based on current state
  // (when session is locked, rules left as-is from previous session — they persist natively)
  await updateBlockingRules();
  await updateBadge();
}

async function migrateSchedule() {
  const { schedule, schedules } = await getLocal(['schedule', 'schedules']);
  if (schedules !== undefined) return; // already migrated
  const migrated = schedule
    ? [{ ...schedule, id: Date.now(), name: 'My Schedule' }]
    : [];
  await chrome.storage.local.set({ schedules: migrated });
  if (schedule) await chrome.storage.local.remove('schedule');
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
// CRYPTO HELPERS
// ─────────────────────────────────────────────────────────────

const PBKDF2_ITERATIONS = 200_000;

function hexToBytes(hex) {
  return new Uint8Array(hex.match(/.{2}/g).map(b => parseInt(b, 16)));
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function generateSalt() {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}

// Derives a 256-bit AES-GCM master key from password + salt using PBKDF2.
// The returned CryptoKey is extractable so we can export it to session storage.
async function deriveKey(password, salt) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: hexToBytes(salt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    true,           // extractable — needed to export to session storage
    ['encrypt', 'decrypt']
  );
}

// Returns SHA-256(raw key bytes) as hex — used as the stored password verifier.
// Knowing SHA-256(key) does NOT reveal the key itself.
async function hashKey(key) {
  const raw = await crypto.subtle.exportKey('raw', key);
  const digest = await crypto.subtle.digest('SHA-256', raw);
  return bytesToHex(new Uint8Array(digest));
}

// Exports the raw key bytes as a hex string for session storage.
async function keyToHex(key) {
  const raw = await crypto.subtle.exportKey('raw', key);
  return bytesToHex(new Uint8Array(raw));
}

// Imports a hex-encoded key back into a CryptoKey object.
async function hexToKey(hex) {
  return crypto.subtle.importKey(
    'raw', hexToBytes(hex), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']
  );
}

// Encrypts any JSON-serialisable value with AES-GCM.
// Returns { iv: hex, data: hex }.
async function encryptJSON(value, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(JSON.stringify(value))
  );
  return { iv: bytesToHex(iv), data: bytesToHex(new Uint8Array(ciphertext)) };
}

// Decrypts a value previously encrypted with encryptJSON.
// Returns the original JS value, or throws on failure.
async function decryptJSON(iv, data, key) {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: hexToBytes(iv) },
    key,
    hexToBytes(data)
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

// Legacy: raw SHA-256 used before salting was added.
// Only used for migration; do not call elsewhere.
async function legacyHash(password) {
  const data = new TextEncoder().encode(password);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return bytesToHex(new Uint8Array(digest));
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
  const { schedules = [] } = await getLocal('schedules');
  if (schedules.length === 0) return false;

  const now = new Date();
  const day = now.getDay();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  return schedules.some(schedule => {
    if (!schedule.enabled) return false;
    if (!schedule.days || !schedule.days.includes(day)) return false;
    const [startH, startM] = schedule.startTime.split(':').map(Number);
    const [endH, endM]     = schedule.endTime.split(':').map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes   = endH * 60 + endM;
    if (startMinutes <= endMinutes) {
      return currentMinutes >= startMinutes && currentMinutes < endMinutes;
    } else {
      return currentMinutes >= startMinutes || currentMinutes < endMinutes;
    }
  });
}

async function updateBlockingRules() {
  const active = await isBlockingActive();
  const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existingRules.map(r => r.id);

  if (!active) {
    // Blocking is off — always safe to clear rules
    if (removeRuleIds.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: [] });
    }
    return;
  }

  // Blocking is on — we need the decrypted blocklist
  const blocklist = await getDecryptedBlocklist();

  if (blocklist === null) {
    // Session is locked: leave existing rules unchanged (they persist from last unlock)
    return;
  }

  if (blocklist.length === 0) {
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
      regexFilter: `^https?://(?:[^/?#]*\\.)?${escapeRegex(domain)}(?:[/?#].*)?$`,
      resourceTypes: ['main_frame']
    }
  }));

  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
}

// Returns the decrypted blocklist array, or null if session is locked / decryption fails.
async function getDecryptedBlocklist() {
  const { sessionEncKey } = await getSession('sessionEncKey');
  if (!sessionEncKey) return null;

  const { blocklistEncrypted, blocklistIV } = await getLocal(['blocklistEncrypted', 'blocklistIV']);
  if (!blocklistEncrypted || !blocklistIV) return [];

  try {
    const key = await hexToKey(sessionEncKey);
    return await decryptJSON(blocklistIV, blocklistEncrypted, key);
  } catch {
    // Decryption failed (corrupted data or wrong key) — leave rules unchanged
    return null;
  }
}

// Encrypts and saves the blocklist. Also updates blocking rules.
async function saveBlocklist(blocklist, key) {
  const { iv, data } = await encryptJSON(blocklist, key);
  await chrome.storage.local.set({ blocklistEncrypted: data, blocklistIV: iv });
  await updateBlockingRules();
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

async function verifyPassword(password) {
  // Lockout check
  const session = await getSession(['lockoutUntil', 'failedAttempts']);

  if (session.lockoutUntil && Date.now() < session.lockoutUntil) {
    const remainingMinutes = Math.ceil((session.lockoutUntil - Date.now()) / 60000);
    return { success: false, locked: true, remainingMinutes };
  }

  const { passwordHash, passwordSalt } = await getLocal(['passwordHash', 'passwordSalt']);

  let key = null;
  let verified = false;

  if (!passwordSalt) {
    // ── Legacy path: old unsalted SHA-256 ─────────────────────
    const hash = await legacyHash(password);
    if (hash === passwordHash) {
      verified = true;
      // Migrate to new PBKDF2 + encrypted blocklist format
      const salt = await generateSalt();
      key = await deriveKey(password, salt);
      const newHash = await hashKey(key);

      // Re-encrypt any existing plaintext blocklist
      const { blocklist: legacyList = [] } = await getLocal('blocklist');
      const updates = { passwordHash: newHash, passwordSalt: salt };
      if (legacyList.length > 0) {
        const { iv, data } = await encryptJSON(legacyList, key);
        updates.blocklistEncrypted = data;
        updates.blocklistIV        = iv;
        updates.blocklist          = null; // remove old key (chrome.storage ignores null removes)
      }
      // Atomic write
      await chrome.storage.local.set(updates);
      if (legacyList.length > 0) {
        await chrome.storage.local.remove('blocklist');
      }
    }
  } else {
    // ── New path: PBKDF2 ──────────────────────────────────────
    key = await deriveKey(password, passwordSalt);
    verified = (await hashKey(key)) === passwordHash;
  }

  if (verified) {
    const keyHex = await keyToHex(key);
    await chrome.storage.session.set({
      sessionUnlocked: true,
      failedAttempts:  0,
      lockoutUntil:    null,
      sessionEncKey:   keyHex
    });
    return { success: true };
  }

  // Wrong password — track attempts
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
  const blocklist = (await getDecryptedBlocklist()) || [];
  if (blocklist.includes(domain)) return blocklist;

  const { sessionEncKey } = await getSession('sessionEncKey');
  const key = await hexToKey(sessionEncKey);
  const newList = [...blocklist, domain];
  await saveBlocklist(newList, key);
  return newList;
}

async function removeSiteFromBlocklist(domain) {
  const blocklist = (await getDecryptedBlocklist()) || [];
  const { sessionEncKey } = await getSession('sessionEncKey');
  const key = await hexToKey(sessionEncKey);
  const newList = blocklist.filter(d => d !== domain);
  await saveBlocklist(newList, key);
  return newList;
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
        'schedules', 'pomodoroSettings',
        'passwordHash', 'customQuotes', 'alwaysBlock'
      ]);

      // Blocklist comes from encrypted storage (decrypted with session key)
      const blocklist = (await getDecryptedBlocklist()) || [];

      return {
        pomodoro: {
          running: !!session.pomodoroRunning,
          phase: session.pomodoroPhase || 'idle',
          endTime: session.pomodoroEndTime || null,
          sessionCount: session.pomodoroSessionCount || 0,
          settings: local.pomodoroSettings || { workDuration: 25, breakDuration: 5 }
        },
        blocklist,
        schedules: local.schedules || [],
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
      const salt = await generateSalt();
      const key  = await deriveKey(message.password, salt);
      const hash = await hashKey(key);
      const keyHex = await keyToHex(key);

      // Atomic write of all new password fields
      await chrome.storage.local.set({ passwordHash: hash, passwordSalt: salt });
      await chrome.storage.session.set({
        sessionUnlocked: true,
        failedAttempts:  0,
        lockoutUntil:    null,
        sessionEncKey:   keyHex
      });
      return { success: true };
    }

    // ── Verify / unlock ─────────────────────────────────────
    case 'VERIFY_PASSWORD': {
      return await verifyPassword(message.password);
    }

    // ── Manual lock ──────────────────────────────────────────
    case 'LOCK_SESSION': {
      await chrome.storage.session.set({ sessionUnlocked: false });
      await chrome.storage.session.remove('sessionEncKey');
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

    // ── Batch import ─────────────────────────────────────────
    case 'IMPORT_SITES': {
      if (!await isSessionUnlocked()) return { error: 'Session locked' };
      const existing = (await getDecryptedBlocklist()) || [];
      const incoming = (message.domains || []).filter(d => d && d.includes('.'));
      const merged   = [...new Set([...existing, ...incoming])];
      const { sessionEncKey } = await getSession('sessionEncKey');
      const key = await hexToKey(sessionEncKey);
      await saveBlocklist(merged, key);
      return { success: true, blocklist: merged, added: merged.length - existing.length };
    }

    // ── Schedules ────────────────────────────────────────────
    case 'UPDATE_SCHEDULES': {
      if (!await isSessionUnlocked()) return { error: 'Session locked' };
      await chrome.storage.local.set({ schedules: message.schedules });
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

    // ── Password change (requires current password + re-encrypts blocklist) ──
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

      // Derive new key and re-encrypt blocklist
      const newSalt   = await generateSalt();
      const newKey    = await deriveKey(message.newPassword, newSalt);
      const newHash   = await hashKey(newKey);
      const newKeyHex = await keyToHex(newKey);

      const blocklist = (await getDecryptedBlocklist()) || [];
      const updates   = { passwordHash: newHash, passwordSalt: newSalt };

      if (blocklist.length > 0) {
        const { iv, data } = await encryptJSON(blocklist, newKey);
        updates.blocklistEncrypted = data;
        updates.blocklistIV        = iv;
      }

      // Atomic write of all password + blocklist fields
      await chrome.storage.local.set(updates);
      await chrome.storage.session.set({ sessionEncKey: newKeyHex });

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
