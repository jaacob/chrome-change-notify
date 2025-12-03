// Background service worker for DOM Change Monitor
// Architecture based on Distill Web Monitor's "sticky window" approach

const DEFAULT_INTERVAL = 60; // 60 minutes = 1 hour
const CHECK_TIMEOUT = 30000; // 30 second timeout for page load
const JS_RENDER_DELAY = 2000; // Wait for JS to render after page load

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
  if (alarm.name.startsWith('monitor_')) {
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
  }
});

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
  const monitor = {
    id: Date.now().toString(),
    url: data.url,
    selector: data.selector,
    selectorPath: data.selectorPath,
    elementPreview: data.elementPreview,
    intervalMinutes: data.intervalMinutes || DEFAULT_INTERVAL,
    lastContent: data.currentContent,
    lastChecked: Date.now(),
    createdAt: Date.now(),
    changeCount: 0,
    // Default to dynamic (JS-rendered) - safer assumption for modern web
    isDynamic: data.isDynamic !== false
  };

  monitors.push(monitor);
  await chrome.storage.local.set({ monitors });
  scheduleMonitor(monitor);
  await updateBadgeForUrl(data.url);

  return { success: true, monitor };
}

async function deleteMonitor(id) {
  const monitors = await getMonitors();
  const monitor = monitors.find(m => m.id === id);
  const filtered = monitors.filter(m => m.id !== id);
  await chrome.storage.local.set({ monitors: filtered });
  await chrome.alarms.clear(`monitor_${id}`);

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
  chrome.alarms.create(`monitor_${monitor.id}`, {
    delayInMinutes: delayMinutes || monitor.intervalMinutes,
    periodInMinutes: monitor.intervalMinutes
  });
}

async function scheduleAllMonitors() {
  const monitors = await getMonitors();
  // Stagger initial checks to prevent stampede after wake/restart
  const staggerMinutes = Math.max(0.1, Math.min(1, monitors.length / 10));

  for (let i = 0; i < monitors.length; i++) {
    scheduleMonitor(monitors[i], i * staggerMinutes);
  }
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
      return { success: false, error: 'Element not found' };
    }

    const currentContent = result.content;
    const changed = currentContent !== monitor.lastContent;

    const updates = { lastChecked: Date.now() };
    if (changed) {
      updates.lastContent = currentContent;
      updates.changeCount = (monitor.changeCount || 0) + 1;
      updates.elementPreview = currentContent.substring(0, 100) +
        (currentContent.length > 100 ? '...' : '');
    }
    await updateMonitorInStorage(monitorId, updates);

    if (changed) {
      await showNotification(
        monitor,
        'Content Changed!',
        `Change detected on ${new URL(monitor.url).hostname}`
      );
    }

    return { success: true, changed };
  } catch (error) {
    console.error('Error checking monitor:', error);
    await updateMonitorInStorage(monitorId, { lastChecked: Date.now() });
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

  // Extract element content
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractElementContent,
    args: [monitor.selector, monitor.selectorPath]
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

// Injected function to extract element content
function extractElementContent(selector, selectorPath) {
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

  if (!element) {
    return { found: false };
  }

  return {
    found: true,
    content: element.textContent.trim()
  };
}

// ============================================================================
// NOTIFICATIONS
// ============================================================================

async function showNotification(monitor, title, message) {
  try {
    await chrome.notifications.create(`notification_${monitor.id}_${Date.now()}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: title,
      message: message,
      priority: 2,
      requireInteraction: true
    });
  } catch (error) {
    console.error('Failed to show notification:', error);
  }
}

chrome.notifications.onClicked.addListener((notificationId) => {
  const parts = notificationId.split('_');
  if (parts[0] === 'notification') {
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
