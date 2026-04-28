// Background service worker for DOM Change Monitor
// Architecture based on Distill Web Monitor's "sticky window" approach

const DEFAULT_INTERVAL = 60; // 60 minutes = 1 hour
const CHECK_TIMEOUT = 30000; // 30 second timeout for page load
const JS_RENDER_DELAY = 2000; // Wait for JS to render after page load
const EXPIRATION_CHECK_GRACE = 60 * 60 * 1000; // Keep checking for 1 hour after expiration
const EXPIRATION_ARCHIVE_DELAY = 24 * 60 * 60 * 1000; // Auto-archive 24 hours after expiration
const DEFAULT_EXTENSION_MINUTES = 2; // Default anti-snipe extension when auction-end text changes

// Best-effort parse of an auction-end-time element's text into a future
// timestamp. Real-world auction labels look like:
//   "Bidding Ends:\nTue, Apr 28, 2026 at 01:07:30 pm CT"
//   "Closes May 30, 2026 3:00 PM PST"
//   "Ends in 2 hours"
// Date.parse trips on "at", on ambiguous tz abbreviations (CT/ET/PT/MT),
// on leading-zero hours combined with day-of-week, and on label prefixes —
// so we normalize aggressively, build several candidate strings, and try
// each. Falls back to time-only and relative-duration matchers.
function parseAuctionEndTime(text) {
  if (!text) return null;
  const raw = String(text).trim();
  if (!raw) return null;

  // Normalize a candidate so Date.parse will accept it. Drops leading
  // day-of-week names, the word "at" between date and time, ambiguous
  // tz abbreviations, and trailing "left"/"remaining" suffixes.
  function normalize(s) {
    return s
      .replace(/\s+/g, ' ')
      .replace(/^(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|s\.?|\.|,)?[\s,]+/i, '')
      .replace(/\s+at\s+(?=\d)/gi, ' ')
      .replace(/\s+(?:CT|ET|PT|MT)\b\s*$/i, '')
      .replace(/\s+(?:left|remaining|to\s+go)\s*$/i, '')
      .trim();
  }

  function stripLabel(s) {
    return s
      .replace(/^(?:auction\s+|lot\s+|bidding\s+)?(?:ends?|closes?|closing|ending|expires?|finishes?)\s*[:\-–—]?\s*/i, '')
      .replace(/^\s*(?:on|at|in)\s+/i, '')
      .replace(/^\s*[:\-–—]\s*/, '')
      .trim();
  }

  // Build candidate strings — different ways to extract a date phrase
  const candidates = new Set();
  candidates.add(normalize(stripLabel(raw)));
  candidates.add(normalize(raw));

  for (const line of raw.split(/\n/)) {
    const t = line.trim();
    if (t) {
      candidates.add(normalize(stripLabel(t)));
      candidates.add(normalize(t));
    }
  }
  const colonMatch = raw.match(/:\s*([\s\S]+)$/);
  if (colonMatch) {
    candidates.add(normalize(colonMatch[1]));
  }

  const oneYear = 365 * 24 * 60 * 60 * 1000;
  for (const candidate of candidates) {
    if (!candidate) continue;
    const ts = Date.parse(candidate);
    if (Number.isFinite(ts) && ts > Date.now() && ts < Date.now() + oneYear) {
      return ts;
    }
  }

  const labelStripped = normalize(stripLabel(raw));

  const timeMatch = labelStripped.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?\s*([a-z]{2,4})?$/i);
  if (timeMatch) {
    let hour = parseInt(timeMatch[1], 10);
    const min = parseInt(timeMatch[2], 10);
    const sec = parseInt(timeMatch[3] || '0', 10);
    const ampm = (timeMatch[4] || '').toLowerCase();
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    const today = new Date();
    let ts = new Date(today.getFullYear(), today.getMonth(), today.getDate(), hour, min, sec).getTime();
    if (ts <= Date.now()) ts += 86400000;
    return ts;
  }

  const tokens = [
    { re: /(\d+)\s*d(?:ays?)?\b/i, ms: 86400000 },
    { re: /(\d+)\s*h(?:ours?|rs?)?\b/i, ms: 3600000 },
    { re: /(\d+)\s*m(?:inutes?|ins?)?\b/i, ms: 60000 },
    { re: /(\d+)\s*s(?:econds?|ecs?)?\b/i, ms: 1000 }
  ];
  let totalMs = 0;
  let matched = false;
  for (const { re, ms } of tokens) {
    const m = labelStripped.match(re);
    if (m) {
      totalMs += parseInt(m[1], 10) * ms;
      matched = true;
    }
  }
  if (matched) return Date.now() + totalMs;

  return null;
}

// Adaptive ramp tiers. When a monitor has expiresAt set, the effective
// interval shortens inside the final hour. The user's intervalMinutes
// always acts as a cap — we never check less often than they configured.
function computeEffectiveInterval(monitor) {
  const userInterval = monitor.intervalMinutes;
  if (!monitor.expiresAt) return userInterval;
  const minutesToExpiry = (monitor.expiresAt - Date.now()) / 60000;
  if (minutesToExpiry <= 0) return userInterval; // grace window: revert to user interval
  if (minutesToExpiry > 60) return userInterval;
  if (minutesToExpiry > 15) return Math.min(5, userInterval);
  return Math.min(1, userInterval);
}

// Queue for sequential processing
let checkQueue = [];
let isProcessing = false;

// Sticky window - created once, reused for all dynamic page checks
let stickyWindowId = null;

// ============================================================================
// EXTENSION LIFECYCLE
// ============================================================================

chrome.runtime.onInstalled.addListener(async () => {
  const result = await chrome.storage.local.get(['monitors']);
  if (!result.monitors) {
    await chrome.storage.local.set({ monitors: [] });
  }
  // Clean up any orphaned sticky window from previous install
  await cleanupOrphanedWindow();
  scheduleAllMonitors();
});

chrome.runtime.onStartup.addListener(async () => {
  // Validate stored window ID on startup
  await cleanupOrphanedWindow();
  scheduleAllMonitors();
});

// Clean up orphaned sticky window if it no longer exists
async function cleanupOrphanedWindow() {
  const stored = await chrome.storage.local.get(['stickyWindowId']);
  if (stored.stickyWindowId) {
    try {
      await chrome.windows.get(stored.stickyWindowId);
      // Window exists, keep it
    } catch (e) {
      // Window doesn't exist, clear the stored ID
      await chrome.storage.local.remove(['stickyWindowId']);
      stickyWindowId = null;
    }
  }
}


// ============================================================================
// BADGE MANAGEMENT
// ============================================================================

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  updateBadge(activeInfo.tabId);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'complete') {
    updateBadge(tabId);
  }
});

async function updateBadge(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url) return;

    const monitors = await getMonitors();
    const count = monitors.filter(m => m.url === tab.url).length;

    if (count > 0) {
      await chrome.action.setBadgeText({ text: count.toString(), tabId });
      await chrome.action.setBadgeBackgroundColor({ color: '#d93025', tabId });
      await chrome.action.setBadgeTextColor({ color: '#ffffff', tabId });
    } else {
      await chrome.action.setBadgeText({ text: '', tabId });
    }
  } catch (error) {
    // Tab might have been closed
  }
}

async function updateBadgeForUrl(url) {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.url === url) {
        await updateBadge(tab.id);
      }
    }
  } catch (error) {
    // Ignore errors
  }
}

// ============================================================================
// ALARM HANDLING
// ============================================================================

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith('expwarn_')) {
    const monitorId = alarm.name.replace('expwarn_', '');
    sendExpirationWarning(monitorId);
  } else if (alarm.name.startsWith('tiergrace_')) {
    // 1-hour grace ended — stop firing the main check alarm. The monitor
    // remains visible (with "Expired" badge) until tierarchive fires at +24h.
    const monitorId = alarm.name.replace('tiergrace_', '');
    chrome.alarms.clear(`monitor_${monitorId}`);
  } else if (alarm.name.startsWith('tierarchive_')) {
    // 24h post-expiration — auto-archive the monitor.
    const monitorId = alarm.name.replace('tierarchive_', '');
    archiveMonitor(monitorId);
  } else if (
    alarm.name.startsWith('tier60_') ||
    alarm.name.startsWith('tier15_') ||
    alarm.name.startsWith('tierexp_')
  ) {
    // Proactive tier-transition alarm — fires at T-60m, T-15m, or T-0 so
    // the main alarm's period gets re-evaluated immediately instead of
    // waiting for the next regular check (which could be up to 60m away).
    const monitorId = alarm.name.replace(/^tier(60|15|exp)_/, '');
    rescheduleMonitor(monitorId);
  } else if (alarm.name.startsWith('monitor_')) {
    const monitorId = alarm.name.replace('monitor_', '');
    queueCheck(monitorId);
  }
});

// ============================================================================
// MESSAGE HANDLING
// ============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'addMonitor':
      addMonitor(message.data).then(sendResponse);
      return true;
    case 'deleteMonitor':
      deleteMonitor(message.id).then(sendResponse);
      return true;
    case 'getMonitors':
      getMonitors().then(sendResponse);
      return true;
    case 'updateMonitor':
      updateMonitor(message.id, message.data).then(sendResponse);
      return true;
    case 'checkNow':
      // For manual checks, run immediately (don't queue)
      checkForChanges(message.id).then(sendResponse);
      return true;
    case 'checkAllNow':
      checkAllMonitors().then(sendResponse);
      return true;
    case 'acknowledgeChange':
      acknowledgeChange(message.id).then(sendResponse);
      return true;
    case 'archiveMonitor':
      archiveMonitor(message.id).then(sendResponse);
      return true;
    case 'unarchiveMonitor':
      unarchiveMonitor(message.id).then(sendResponse);
      return true;
    case 'toggleStar':
      toggleStar(message.id).then(sendResponse);
      return true;
    case 'setExpiration':
      setExpiration(message.id, message.expiresAt).then(sendResponse);
      return true;
    case 'setNotes':
      updateMonitorInStorage(message.id, { notes: message.notes }).then(() => {
        sendResponse({ success: true });
      });
      return true;
    case 'pickAuctionEndElement':
      pickAuctionEndElement(message.monitorId).then(sendResponse);
      return true;
    case 'setAuctionEndElement':
      setAuctionEndElement(message.monitorId, message.data).then(sendResponse);
      return true;
    case 'clearAuctionEndElement':
      updateMonitorInStorage(message.monitorId, {
        auctionEndSelector: null,
        auctionEndSelectorPath: null,
        auctionEndContent: null
      }).then(() => sendResponse({ success: true }));
      return true;
    case 'updateExtensionMinutes':
      updateMonitorInStorage(message.monitorId, {
        extensionMinutes: Math.max(1, Math.min(60, parseInt(message.minutes) || DEFAULT_EXTENSION_MINUTES))
      }).then(() => sendResponse({ success: true }));
      return true;
  }
});

// Clear the change indicator for a monitor
async function acknowledgeChange(monitorId) {
  await updateMonitorInStorage(monitorId, { lastChangeDetected: null });
  return { success: true };
}

// Open the monitor's URL in a new foreground tab and start the picker in
// auction-end mode. The user clicks the auction end-time element on the
// page; content.js sends back setAuctionEndElement and closes the tab.
async function pickAuctionEndElement(monitorId) {
  const monitors = await getMonitors();
  const monitor = monitors.find(m => m.id === monitorId);
  if (!monitor) return { success: false, error: 'Monitor not found' };

  const tab = await chrome.tabs.create({ url: monitor.url, active: true });

  return new Promise((resolve) => {
    const onUpdated = async (updatedTabId, info) => {
      if (updatedTabId !== tab.id || info.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(onUpdated);

      const startMessage = { action: 'startSelection', mode: 'auctionEnd', monitorId };
      try {
        await chrome.tabs.sendMessage(tab.id, startMessage);
        resolve({ success: true });
      } catch (e) {
        // content.js may not be loaded yet (e.g., on a page that loaded
        // before the extension was installed) — inject and retry.
        try {
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
          await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] });
          await chrome.tabs.sendMessage(tab.id, startMessage);
          resolve({ success: true });
        } catch (e2) {
          resolve({ success: false, error: e2.message });
        }
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function setAuctionEndElement(monitorId, data) {
  const monitors = await getMonitors();
  const monitor = monitors.find(m => m.id === monitorId);
  if (!monitor) return { success: false, error: 'Monitor not found' };

  const updates = {
    auctionEndSelector: data.selector,
    auctionEndSelectorPath: data.selectorPath,
    // Seed the baseline from the picked text so the first check doesn't
    // false-trigger anti-snipe (and so we have something to compare against)
    auctionEndContent: data.text || null
  };

  // Only auto-fill expiresAt when it isn't already set — never overwrite
  // a value the user typed in manually.
  let parsedExpiresAt = null;
  if (!monitor.expiresAt && data.text) {
    parsedExpiresAt = parseAuctionEndTime(data.text);
    if (parsedExpiresAt) {
      updates.expiresAt = parsedExpiresAt;
    }
  }

  await updateMonitorInStorage(monitorId, updates);

  if (parsedExpiresAt) {
    scheduleExpirationWarning(monitorId, parsedExpiresAt);
    // Reschedule the monitor alarm so the new expiresAt feeds the ramp
    const refreshed = (await getMonitors()).find(m => m.id === monitorId);
    if (refreshed) scheduleMonitor(refreshed);
  }

  return { success: true, parsedExpiresAt };
}

// Archive a monitor (stop checking but keep all data)
async function archiveMonitor(monitorId) {
  await updateMonitorInStorage(monitorId, {
    isArchived: true,
    lastChangeDetected: null // Clear change indicator when archiving
  });
  await clearMonitorAlarms(monitorId);
  return { success: true };
}

// Unarchive a monitor (resume checking)
async function unarchiveMonitor(monitorId) {
  const monitors = await getMonitors();
  const monitor = monitors.find(m => m.id === monitorId);

  if (!monitor) {
    return { success: false, error: 'Monitor not found' };
  }

  await updateMonitorInStorage(monitorId, { isArchived: false });
  // Reschedule the alarm
  scheduleMonitor(monitor);
  return { success: true };
}

// Toggle starred status on a monitor
async function toggleStar(monitorId) {
  const monitors = await getMonitors();
  const monitor = monitors.find(m => m.id === monitorId);
  if (!monitor) return { success: false, error: 'Monitor not found' };

  await updateMonitorInStorage(monitorId, { isStarred: !monitor.isStarred });
  return { success: true, isStarred: !monitor.isStarred };
}

// Set or clear expiration on a monitor
async function setExpiration(monitorId, expiresAt) {
  await updateMonitorInStorage(monitorId, { expiresAt: expiresAt || null });

  // Schedule or clear the 30-min warning notification
  scheduleExpirationWarning(monitorId, expiresAt || null);

  if (expiresAt && Date.now() >= expiresAt + EXPIRATION_ARCHIVE_DELAY) {
    // Expired 24+ hours ago - auto-archive
    await archiveMonitor(monitorId);
  } else if (expiresAt && Date.now() >= expiresAt + EXPIRATION_CHECK_GRACE) {
    // Past 1h grace period but within 24h - stop checking but don't archive
    await chrome.alarms.clear(`monitor_${monitorId}`);
  } else {
    // Clear existing alarm and reschedule (scheduleMonitor checks expiration)
    await chrome.alarms.clear(`monitor_${monitorId}`);
    const monitors = await getMonitors();
    const monitor = monitors.find(m => m.id === monitorId);
    if (monitor && !monitor.isArchived) {
      scheduleMonitor(monitor);
    }
  }

  return { success: true };
}

const EXPIRATION_WARNING_MINUTES = 30;

// Schedule a one-time alarm to fire 30 min before expiration
function scheduleExpirationWarning(monitorId, expiresAt) {
  // Clear any existing warning alarm for this monitor
  chrome.alarms.clear(`expwarn_${monitorId}`);

  if (!expiresAt) return;

  const warningTime = expiresAt - (EXPIRATION_WARNING_MINUTES * 60 * 1000);
  const delayMs = warningTime - Date.now();

  // Only schedule if the warning time is in the future
  if (delayMs > 0) {
    chrome.alarms.create(`expwarn_${monitorId}`, {
      when: warningTime
    });
  }
}

async function sendExpirationWarning(monitorId) {
  const monitors = await getMonitors();
  const monitor = monitors.find(m => m.id === monitorId);
  if (!monitor || monitor.isArchived) return;

  const url = new URL(monitor.url);
  const displayName = monitor.pageTitle || url.hostname + (url.pathname !== '/' ? url.pathname : '');
  await showNotification(
    monitor,
    `Expiring in ${EXPIRATION_WARNING_MINUTES} min`,
    displayName
  );
}

// Check all monitors sequentially with progress reporting
async function checkAllMonitors() {
  const allMonitors = await getMonitors();
  // Only check active (non-archived, non-expired) monitors
  const monitors = allMonitors.filter(m => !m.isArchived && !(m.expiresAt && Date.now() >= m.expiresAt + EXPIRATION_CHECK_GRACE));

  if (monitors.length === 0) {
    return { success: true, total: 0, changedCount: 0 };
  }

  let changedCount = 0;

  // Initialize progress
  await chrome.storage.local.set({
    checkAllProgress: {
      status: 'running',
      current: 0,
      total: monitors.length,
      currentUrl: '',
      changedCount: 0
    }
  });

  for (let i = 0; i < monitors.length; i++) {
    const monitor = monitors[i];
    const hostname = new URL(monitor.url).hostname;
    const pathname = new URL(monitor.url).pathname;
    const displayUrl = hostname + (pathname !== '/' ? pathname : '');

    // Update progress - show which monitor we're checking (1-indexed for humans)
    await chrome.storage.local.set({
      checkAllProgress: {
        status: 'running',
        current: i + 1,
        total: monitors.length,
        currentUrl: `Checking: ${displayUrl}`,
        changedCount
      }
    });

    try {
      const result = await checkForChanges(monitor.id);
      if (result.changed) {
        changedCount++;
      }
    } catch (error) {
      console.error('Error checking monitor:', monitor.id, error);
    }

    // Small delay between checks
    if (i < monitors.length - 1) {
      await sleep(1000);
    }
  }

  // Mark complete
  await chrome.storage.local.set({
    checkAllProgress: {
      status: 'complete',
      current: monitors.length,
      total: monitors.length,
      currentUrl: '',
      changedCount
    }
  });

  return { success: true, total: monitors.length, changedCount };
}

// ============================================================================
// QUEUE MANAGEMENT
// ============================================================================

function queueCheck(monitorId) {
  if (!checkQueue.includes(monitorId)) {
    checkQueue.push(monitorId);
  }
  processQueue();
}

async function processQueue() {
  if (isProcessing || checkQueue.length === 0) return;

  isProcessing = true;

  while (checkQueue.length > 0) {
    const monitorId = checkQueue.shift();
    try {
      await checkForChanges(monitorId);
    } catch (error) {
      console.error('Error processing monitor:', monitorId, error);
    }
    // Small delay between checks
    if (checkQueue.length > 0) {
      await sleep(1000);
    }
  }

  isProcessing = false;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// MONITOR CRUD OPERATIONS
// ============================================================================

async function addMonitor(data) {
  const monitors = await getMonitors();
  const parsedExpiresAt = data.auctionEndText ? parseAuctionEndTime(data.auctionEndText) : null;
  const monitor = {
    id: Date.now().toString(),
    url: data.url,
    pageTitle: data.pageTitle || '',
    selector: data.selector,
    selectorPath: data.selectorPath,
    elementPreview: data.elementPreview,
    intervalMinutes: data.intervalMinutes || DEFAULT_INTERVAL,
    lastContent: data.currentContent,
    lastChecked: Date.now(),
    createdAt: Date.now(),
    changeCount: 0,
    // Default to dynamic (JS-rendered) - safer assumption for modern web
    isDynamic: data.isDynamic !== false,
    isArchived: false,
    isStarred: false,
    expiresAt: parsedExpiresAt,
    notes: '',
    auctionEndSelector: data.auctionEndSelector || null,
    auctionEndSelectorPath: data.auctionEndSelectorPath || null,
    // Seed the baseline so the first check doesn't false-trigger anti-snipe
    auctionEndContent: data.auctionEndText || null,
    extensionMinutes: DEFAULT_EXTENSION_MINUTES,
    // Initialize change history with the initial content
    changeHistory: [{
      timestamp: Date.now(),
      content: data.currentContent,
      preview: data.elementPreview
    }]
  };

  monitors.push(monitor);
  await chrome.storage.local.set({ monitors });
  scheduleMonitor(monitor);
  if (parsedExpiresAt) {
    scheduleExpirationWarning(monitor.id, parsedExpiresAt);
  }
  await updateBadgeForUrl(data.url);

  return { success: true, monitor };
}

async function deleteMonitor(id) {
  const monitors = await getMonitors();
  const monitor = monitors.find(m => m.id === id);
  const filtered = monitors.filter(m => m.id !== id);
  await chrome.storage.local.set({ monitors: filtered });
  await clearMonitorAlarms(id);

  if (monitor) {
    await updateBadgeForUrl(monitor.url);
  }

  // Close sticky window if no monitors left
  if (filtered.length === 0) {
    await closeStickyWindow();
  }

  return { success: true };
}

async function updateMonitor(id, data) {
  const monitors = await getMonitors();
  const index = monitors.findIndex(m => m.id === id);

  if (index === -1) {
    return { success: false, error: 'Monitor not found' };
  }

  const oldInterval = monitors[index].intervalMinutes;
  monitors[index] = { ...monitors[index], ...data };
  await chrome.storage.local.set({ monitors });

  if (data.intervalMinutes && data.intervalMinutes !== oldInterval) {
    scheduleMonitor(monitors[index]);
  }

  return { success: true, monitor: monitors[index] };
}

async function getMonitors() {
  const result = await chrome.storage.local.get(['monitors']);
  return result.monitors || [];
}

async function updateMonitorInStorage(monitorId, updates) {
  const result = await chrome.storage.local.get(['monitors']);
  const monitors = result.monitors || [];
  const index = monitors.findIndex(m => m.id === monitorId);

  if (index !== -1) {
    monitors[index] = { ...monitors[index], ...updates };
    await chrome.storage.local.set({ monitors });
  }
}

// ============================================================================
// SCHEDULING
// ============================================================================

function scheduleMonitor(monitor, delayMinutes = 0) {
  // Don't schedule archived or expired monitors
  if (monitor.isArchived) return;
  if (monitor.expiresAt && Date.now() >= monitor.expiresAt + EXPIRATION_CHECK_GRACE) return;

  const effectiveInterval = computeEffectiveInterval(monitor);
  chrome.alarms.create(`monitor_${monitor.id}`, {
    delayInMinutes: delayMinutes || effectiveInterval,
    periodInMinutes: effectiveInterval
  });
  scheduleTierTransitions(monitor.id, monitor.expiresAt);
}

// One-shot alarms at each tier boundary. The first three (tier60/tier15/
// tierexp) drive ramp transitions; tiergrace stops the main alarm at the
// end of the 1-hour post-expiration grace window so we don't keep waking
// the SW for no-op checks; tierarchive auto-archives at +24h independently
// of whether any check happens to run. Without tiergrace, the main alarm
// would continue firing every userInterval through the entire 1h-to-24h
// window, with checkForChanges short-circuiting each one as wasted work.
// 1s slop on each boundary ensures the alarm lands just inside the new
// state rather than racing it.
function scheduleTierTransitions(monitorId, expiresAt) {
  chrome.alarms.clear(`tier60_${monitorId}`);
  chrome.alarms.clear(`tier15_${monitorId}`);
  chrome.alarms.clear(`tierexp_${monitorId}`);
  chrome.alarms.clear(`tiergrace_${monitorId}`);
  chrome.alarms.clear(`tierarchive_${monitorId}`);

  if (!expiresAt) return;

  const now = Date.now();
  const SLOP = 1000;
  const tier60 = expiresAt - 60 * 60 * 1000 + SLOP;
  const tier15 = expiresAt - 15 * 60 * 1000 + SLOP;
  const tierexp = expiresAt + SLOP;
  const tiergrace = expiresAt + EXPIRATION_CHECK_GRACE + SLOP;
  const tierarchive = expiresAt + EXPIRATION_ARCHIVE_DELAY + SLOP;

  if (tier60 > now) chrome.alarms.create(`tier60_${monitorId}`, { when: tier60 });
  if (tier15 > now) chrome.alarms.create(`tier15_${monitorId}`, { when: tier15 });
  if (tierexp > now) chrome.alarms.create(`tierexp_${monitorId}`, { when: tierexp });
  if (tiergrace > now) chrome.alarms.create(`tiergrace_${monitorId}`, { when: tiergrace });
  if (tierarchive > now) chrome.alarms.create(`tierarchive_${monitorId}`, { when: tierarchive });
}

async function clearMonitorAlarms(monitorId) {
  await chrome.alarms.clear(`monitor_${monitorId}`);
  await chrome.alarms.clear(`expwarn_${monitorId}`);
  await chrome.alarms.clear(`tier60_${monitorId}`);
  await chrome.alarms.clear(`tier15_${monitorId}`);
  await chrome.alarms.clear(`tierexp_${monitorId}`);
  await chrome.alarms.clear(`tiergrace_${monitorId}`);
  await chrome.alarms.clear(`tierarchive_${monitorId}`);
}

// Re-fetch monitor and reschedule its alarm only when the effective interval
// has actually changed (tier transition or anti-snipe extension). The alarm
// is already periodic at the right value within a stable tier — recreating
// it on every check wastes work and starves popup/UI responsiveness when
// ramped to 1-min intervals.
async function rescheduleMonitor(monitorId) {
  const monitors = await getMonitors();
  const monitor = monitors.find(m => m.id === monitorId);
  if (!monitor || monitor.isArchived) return;
  if (monitor.expiresAt && Date.now() >= monitor.expiresAt + EXPIRATION_CHECK_GRACE) return;

  const desired = computeEffectiveInterval(monitor);
  const existing = await chrome.alarms.get(`monitor_${monitor.id}`);
  if (existing && existing.periodInMinutes === desired) return;

  scheduleMonitor(monitor);
}

async function scheduleAllMonitors() {
  const monitors = await getMonitors();
  const nonArchived = monitors.filter(m => !m.isArchived);
  const isPastGrace = (m) => m.expiresAt && Date.now() >= m.expiresAt + EXPIRATION_CHECK_GRACE;
  const isPastArchive = (m) => m.expiresAt && Date.now() >= m.expiresAt + EXPIRATION_ARCHIVE_DELAY;

  const active = nonArchived.filter(m => !isPastGrace(m));
  // Stagger initial checks to prevent stampede after wake/restart
  const staggerMinutes = Math.max(0.1, Math.min(1, active.length / 10));

  for (let i = 0; i < active.length; i++) {
    scheduleMonitor(active[i], i * staggerMinutes);
  }

  // Heal post-grace-but-not-archived monitors: clear any stale main alarm
  // left over from an older build, then either auto-archive (past +24h) or
  // schedule the tierarchive alarm so it cleans up at the right time.
  for (const m of nonArchived) {
    if (!isPastGrace(m)) continue;
    await chrome.alarms.clear(`monitor_${m.id}`);
    if (isPastArchive(m)) {
      await archiveMonitor(m.id);
    } else {
      scheduleTierTransitions(m.id, m.expiresAt);
    }
  }

  // Schedule expiration warning alarms for all monitors with expirations
  nonArchived.forEach(m => {
    if (m.expiresAt) scheduleExpirationWarning(m.id, m.expiresAt);
  });
}

// ============================================================================
// STICKY WINDOW MANAGEMENT
// ============================================================================

async function ensureStickyWindow() {
  // First, try to get window ID from memory
  if (stickyWindowId) {
    try {
      const window = await chrome.windows.get(stickyWindowId);
      if (window.state !== 'minimized') {
        await chrome.windows.update(stickyWindowId, { state: 'minimized' });
      }
      return stickyWindowId;
    } catch (e) {
      stickyWindowId = null;
    }
  }

  // Memory was empty (service worker restarted) - check storage
  const stored = await chrome.storage.local.get(['stickyWindowId']);
  if (stored.stickyWindowId) {
    try {
      const window = await chrome.windows.get(stored.stickyWindowId);
      if (window.state !== 'minimized') {
        await chrome.windows.update(stored.stickyWindowId, { state: 'minimized' });
      }
      stickyWindowId = stored.stickyWindowId;
      return stickyWindowId;
    } catch (e) {
      // Window no longer exists, clear storage
      await chrome.storage.local.remove(['stickyWindowId']);
    }
  }

  // No valid window exists - create new one
  const window = await chrome.windows.create({
    url: 'about:blank',
    type: 'popup',
    width: 1024,
    height: 768,
    focused: false
  });

  // Minimize immediately
  await chrome.windows.update(window.id, { state: 'minimized' });

  // Save to both memory and storage
  stickyWindowId = window.id;
  await chrome.storage.local.set({ stickyWindowId: window.id });

  return stickyWindowId;
}

async function closeStickyWindow() {
  // Get from storage in case service worker restarted
  const stored = await chrome.storage.local.get(['stickyWindowId']);
  const windowIdToClose = stickyWindowId || stored.stickyWindowId;

  if (windowIdToClose) {
    try {
      await chrome.windows.remove(windowIdToClose);
    } catch (e) {
      // Already closed
    }
  }

  stickyWindowId = null;
  await chrome.storage.local.remove(['stickyWindowId']);
}

// ============================================================================
// CHANGE DETECTION
// ============================================================================

async function checkForChanges(monitorId) {
  const monitors = await getMonitors();
  const monitor = monitors.find(m => m.id === monitorId);

  if (!monitor) {
    return { success: false, error: 'Monitor not found' };
  }

  // Handle expired monitors (1-hour grace period for checking, then stop)
  if (monitor.expiresAt && Date.now() >= monitor.expiresAt + EXPIRATION_CHECK_GRACE) {
    if (Date.now() >= monitor.expiresAt + EXPIRATION_ARCHIVE_DELAY && !monitor.isArchived) {
      // 24+ hours past expiration - auto-archive
      await updateMonitorInStorage(monitorId, {
        isArchived: true,
        lastChangeDetected: null
      });
      await chrome.alarms.clear(`monitor_${monitorId}`);
    }
    // Past grace period, skip the check
    return { success: true, changed: false, expired: true };
  }

  try {
    let result;

    if (monitor.isDynamic === false) {
      // Static page - use fast fetch approach
      result = await checkStaticPage(monitor);
    } else {
      // Dynamic page - use sticky window approach
      result = await checkDynamicPage(monitor);
    }

    if (!result || !result.found) {
      await updateMonitorInStorage(monitorId, { lastChecked: Date.now() });
      await showNotification(
        monitor,
        'Element Not Found',
        `The monitored element on ${new URL(monitor.url).hostname} could not be found.`
      );
      await rescheduleMonitor(monitorId);
      return { success: false, error: 'Element not found' };
    }

    const currentContent = result.content;
    const changed = currentContent !== monitor.lastContent;

    const updates = { lastChecked: Date.now() };
    // Backfill page title if missing
    if (!monitor.pageTitle && result.pageTitle) {
      updates.pageTitle = result.pageTitle;
    }
    if (changed) {
      const newPreview = currentContent.substring(0, 100) +
        (currentContent.length > 100 ? '...' : '');
      // Save previous content before overwriting
      updates.previousContent = monitor.lastContent;
      updates.previousPreview = monitor.elementPreview;
      // Update to new content
      updates.lastContent = currentContent;
      updates.changeCount = (monitor.changeCount || 0) + 1;
      updates.elementPreview = newPreview;
      updates.lastChangeDetected = Date.now();
      // Add to change history
      const changeHistory = monitor.changeHistory || [];
      changeHistory.push({
        timestamp: Date.now(),
        content: currentContent,
        preview: newPreview
      });
      updates.changeHistory = changeHistory;
    }
    await updateMonitorInStorage(monitorId, updates);

    if (changed) {
      const url = new URL(monitor.url);
      const displayUrl = url.hostname + (url.pathname !== '/' ? url.pathname : '');
      // Truncate content for notification (keep it readable)
      const notificationContent = currentContent.length > 150
        ? currentContent.substring(0, 150) + '...'
        : currentContent;
      await showNotification(
        monitor,
        `Change on ${displayUrl}`,
        notificationContent
      );
    }

    // Anti-snipe: when an auction-end-time element is configured and its
    // displayed text changed, bump expiresAt by extensionMinutes (default 2).
    // Text-change-detection beats parsing — works regardless of date format.
    if (monitor.auctionEndSelector && result.auctionEndText && monitor.expiresAt) {
      if (monitor.auctionEndContent && monitor.auctionEndContent !== result.auctionEndText) {
        const ext = (monitor.extensionMinutes || DEFAULT_EXTENSION_MINUTES) * 60000;
        const newExpiresAt = monitor.expiresAt + ext;
        await updateMonitorInStorage(monitorId, {
          expiresAt: newExpiresAt,
          auctionEndContent: result.auctionEndText
        });
        scheduleExpirationWarning(monitorId, newExpiresAt);
        // expiresAt moved — tier alarms must shift even if the current tier
        // didn't change (rescheduleMonitor would no-op on same period)
        scheduleTierTransitions(monitorId, newExpiresAt);
      } else if (!monitor.auctionEndContent) {
        // First sighting — store baseline text without extending
        await updateMonitorInStorage(monitorId, { auctionEndContent: result.auctionEndText });
      }
    }

    await rescheduleMonitor(monitorId);
    return { success: true, changed };
  } catch (error) {
    console.error('Error checking monitor:', error);
    await updateMonitorInStorage(monitorId, { lastChecked: Date.now() });
    await rescheduleMonitor(monitorId);
    return { success: false, error: error.message };
  }
}

// Check static page using fetch (fast, no window needed)
async function checkStaticPage(monitor) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CHECK_TIMEOUT);

  try {
    const response = await fetch(monitor.url, {
      credentials: 'include',
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    return parseHtmlForElement(html, monitor.selector, monitor.selectorPath);
  } finally {
    clearTimeout(timeoutId);
  }
}

// Parse HTML string and extract element (for static pages)
function parseHtmlForElement(html, selector, selectorPath) {
  // Use DOMParser in a roundabout way - inject into about:blank
  // Actually, we can't use DOMParser in service worker
  // For static pages, we'll still need to use the window, but could optimize later
  // For now, fall back to dynamic approach
  return null; // Will trigger dynamic fallback
}

// Check dynamic page using sticky window
async function checkDynamicPage(monitor) {
  const windowId = await ensureStickyWindow();
  const windowInfo = await chrome.windows.get(windowId, { populate: true });
  const tabId = windowInfo.tabs[0].id;

  // Navigate to URL
  await chrome.tabs.update(tabId, { url: monitor.url });

  // Wait for page load with timeout
  await waitForPageLoad(tabId, CHECK_TIMEOUT);

  // Wait for JS to render
  await sleep(JS_RENDER_DELAY);

  // Extract element content (and auction-end text if configured)
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractElementContent,
    args: [
      monitor.selector,
      monitor.selectorPath,
      monitor.auctionEndSelector || null,
      monitor.auctionEndSelectorPath || null
    ]
  });

  return results[0]?.result;
}

function waitForPageLoad(tabId, timeout) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Page load timeout'));
    }, timeout);

    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === 'complete') {
        clearTimeout(timeoutId);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);

    // Check if already loaded
    chrome.tabs.get(tabId).then(tab => {
      if (tab.status === 'complete' && tab.url !== 'about:blank') {
        clearTimeout(timeoutId);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });
}

// Injected function to extract element content. When auction selectors are
// provided, also extracts that element's text — used by the anti-snipe logic
// to detect bid-extended close times.
function extractElementContent(selector, selectorPath, auctionSelector, auctionPath) {
  function getElementByPath(path) {
    let current = document.body;
    if (!current) return null;

    for (const index of path) {
      if (!current.children) return null;
      const children = Array.from(current.children);
      if (index >= children.length) return null;
      current = children[index];
    }
    return current;
  }

  let element = null;

  if (selector) {
    element = document.querySelector(selector);
  }

  if (!element && selectorPath) {
    element = getElementByPath(selectorPath);
  }

  let auction = null;
  if (auctionSelector) {
    auction = document.querySelector(auctionSelector);
  }
  if (!auction && auctionPath) {
    auction = getElementByPath(auctionPath);
  }

  if (!element) {
    return { found: false };
  }

  return {
    found: true,
    content: element.textContent.trim(),
    auctionEndText: auction ? auction.textContent.trim() : null,
    pageTitle: document.title
  };
}

// ============================================================================
// NOTIFICATIONS
// ============================================================================

async function showNotification(monitor, title, message) {
  const notificationId = `monitor_${monitor.id}_${Date.now()}`;
  const iconUrl = chrome.runtime.getURL('icons/icon128.png');

  try {
    await chrome.notifications.create(notificationId, {
      type: 'basic',
      iconUrl: iconUrl,
      title: title,
      message: message,
      priority: 2
      // Note: requireInteraction is intentionally omitted - it breaks notifications on macOS
    });
    return notificationId;
  } catch (error) {
    console.error('Failed to show notification:', error);
    return null;
  }
}

chrome.notifications.onClicked.addListener((notificationId) => {
  const parts = notificationId.split('_');
  if (parts[0] === 'monitor') {
    const monitorId = parts[1];
    getMonitors().then(monitors => {
      const monitor = monitors.find(m => m.id === monitorId);
      if (monitor) {
        chrome.tabs.create({ url: monitor.url });
      }
    });
    chrome.notifications.clear(notificationId);
  }
});
