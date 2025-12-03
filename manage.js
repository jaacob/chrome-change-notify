let monitors = [];
let timestampInterval = null;
let isCheckingAll = false;
let currentFilter = 'all';

document.addEventListener('DOMContentLoaded', () => {
  loadMonitors();
  setupCheckAllButton();
  setupFilterTabs();
  setupNotificationBanner();
  listenForProgressUpdates();
  // Update relative timestamps every minute
  timestampInterval = setInterval(updateTimestamps, 60000);
});

// Clean up interval when page is hidden/closed
document.addEventListener('visibilitychange', () => {
  if (document.hidden && timestampInterval) {
    clearInterval(timestampInterval);
    timestampInterval = null;
  } else if (!document.hidden && !timestampInterval) {
    updateTimestamps();
    timestampInterval = setInterval(updateTimestamps, 60000);
  }
});

function setupCheckAllButton() {
  const checkAllBtn = document.getElementById('checkAllBtn');
  checkAllBtn.addEventListener('click', checkAllNow);
}

function setupFilterTabs() {
  const filterTabs = document.querySelectorAll('.filter-tab');
  filterTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const filter = tab.dataset.filter;
      currentFilter = filter;

      // Update active tab
      filterTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      // Apply filter
      applyFilter();
    });
  });
}

function applyFilter() {
  const cards = document.querySelectorAll('.monitor-card');
  let visibleCount = 0;

  cards.forEach(card => {
    const isChanged = card.classList.contains('changed');
    const shouldShow = currentFilter === 'all' || (currentFilter === 'changed' && isChanged);

    card.style.display = shouldShow ? 'block' : 'none';
    if (shouldShow) visibleCount++;
  });

  // Show "no results" message if needed
  const monitorList = document.querySelector('.monitor-list');
  const existingNoResults = document.querySelector('.no-results');

  if (existingNoResults) {
    existingNoResults.remove();
  }

  if (visibleCount === 0 && monitors.length > 0) {
    const noResults = document.createElement('div');
    noResults.className = 'no-results';
    noResults.textContent = currentFilter === 'changed'
      ? 'No changed monitors. All monitors are up to date!'
      : 'No monitors found.';
    monitorList.appendChild(noResults);
  }
}

function updateFilterCounts() {
  const changedCount = monitors.filter(m => m.lastChangeDetected).length;
  const totalCount = monitors.length;

  document.getElementById('countAll').textContent = totalCount;
  document.getElementById('countChanged').textContent = changedCount;

  // Show/hide filter bar
  const filterBar = document.getElementById('filterBar');
  if (totalCount > 0) {
    filterBar.classList.add('active');
  } else {
    filterBar.classList.remove('active');
  }
}

function setupNotificationBanner() {
  const banner = document.getElementById('notificationBanner');
  const enableBtn = document.getElementById('enableNotificationsBtn');

  // Check current notification permission
  checkNotificationPermission();

  enableBtn.addEventListener('click', async () => {
    try {
      const permission = await Notification.requestPermission();

      if (permission === 'granted') {
        banner.classList.add('hidden');
        showToast('Notifications enabled!', 'success');

        // Send a test notification
        const notification = new Notification('DOM Monitor', {
          body: 'Notifications are now enabled! You\'ll be alerted when changes are detected.',
          icon: chrome.runtime.getURL('icons/icon128.png')
        });

        // Store that we've granted permission
        chrome.storage.local.set({ notificationsEnabled: true });
      } else {
        showToast('Notification permission denied', 'error');
      }
    } catch (error) {
      console.error('Error requesting notification permission:', error);
      showToast('Failed to enable notifications', 'error');
    }
  });
}

function checkNotificationPermission() {
  const banner = document.getElementById('notificationBanner');

  if (!('Notification' in window)) {
    banner.classList.add('hidden');
    return;
  }

  if (Notification.permission === 'granted') {
    banner.classList.add('hidden');
  } else {
    banner.classList.remove('hidden');
  }
}

function listenForProgressUpdates() {
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.checkAllProgress) {
      const progress = changes.checkAllProgress.newValue;
      if (progress) {
        updateProgressUI(progress);
      }
    }
  });

  // Check if there's an active check in progress on page load
  chrome.storage.local.get(['checkAllProgress'], (result) => {
    if (result.checkAllProgress && result.checkAllProgress.status === 'running') {
      updateProgressUI(result.checkAllProgress);
    }
  });
}

function updateProgressUI(progress) {
  const progressBar = document.getElementById('progressBar');
  const progressCount = document.getElementById('progressCount');
  const progressFill = document.getElementById('progressFill');
  const progressCurrent = document.getElementById('progressCurrent');
  const checkAllBtn = document.getElementById('checkAllBtn');

  if (progress.status === 'running') {
    isCheckingAll = true;
    progressBar.classList.add('active');
    checkAllBtn.disabled = true;
    checkAllBtn.textContent = 'Checking...';

    const percent = progress.total > 0 ? (progress.current / progress.total) * 100 : 0;
    progressCount.textContent = `${progress.current} / ${progress.total}`;
    progressFill.style.width = `${percent}%`;
    progressCurrent.textContent = progress.currentUrl || 'Starting...';
  } else if (progress.status === 'complete') {
    isCheckingAll = false;
    progressBar.classList.remove('active');
    checkAllBtn.disabled = false;
    checkAllBtn.textContent = 'Check All Now';

    const changedCount = progress.changedCount || 0;
    if (changedCount > 0) {
      showToast(`Done! ${changedCount} change${changedCount > 1 ? 's' : ''} detected.`, 'success');
    } else {
      showToast('Done! No changes detected.', 'success');
    }

    // Refresh the list to show updated timestamps/previews
    loadMonitors();

    // Clear progress from storage
    chrome.storage.local.remove(['checkAllProgress']);
  }
}

function checkAllNow() {
  if (isCheckingAll || monitors.length === 0) return;

  isCheckingAll = true;
  const checkAllBtn = document.getElementById('checkAllBtn');
  checkAllBtn.disabled = true;
  checkAllBtn.textContent = 'Checking...';

  chrome.runtime.sendMessage({ action: 'checkAllNow' });
}

function updateTimestamps() {
  monitors.forEach(monitor => {
    const card = document.getElementById(`monitor-${monitor.id}`);
    if (card) {
      const lastCheckedEl = card.querySelector('[data-last-checked]');
      if (lastCheckedEl) {
        lastCheckedEl.textContent = `Last checked: ${formatRelativeTime(monitor.lastChecked)}`;
      }
    }
  });
}

const INTERVAL_OPTIONS = [
  { value: 1, label: '1 minute' },
  { value: 5, label: '5 minutes' },
  { value: 15, label: '15 minutes' },
  { value: 30, label: '30 minutes' },
  { value: 60, label: '1 hour' },
  { value: 120, label: '2 hours' },
  { value: 360, label: '6 hours' },
  { value: 720, label: '12 hours' },
  { value: 1440, label: '1 day' }
];

function loadMonitors() {
  // Read directly from storage instead of messaging service worker
  // This is more reliable, especially after Chrome restart
  chrome.storage.local.get(['monitors'], (result) => {
    monitors = result.monitors || [];
    renderMonitors(monitors);
  });
}

function renderMonitors(monitors) {
  const content = document.getElementById('content');
  const checkAllBtn = document.getElementById('checkAllBtn');

  if (monitors.length === 0) {
    checkAllBtn.style.display = 'none';
    document.getElementById('filterBar').classList.remove('active');
    content.innerHTML = `
      <div class="empty-state">
        <div class="icon">🔍</div>
        <h2>No monitors yet</h2>
        <p>Click the extension icon on any page and select an element to start monitoring.</p>
      </div>
    `;
    return;
  }

  // Show the Check All button when there are monitors
  checkAllBtn.style.display = 'block';

  const html = `
    <div class="monitor-list">
      ${monitors.map(monitor => renderMonitorCard(monitor)).join('')}
    </div>
  `;

  content.innerHTML = html;

  // Update filter counts
  updateFilterCounts();

  // Add event listeners
  monitors.forEach(monitor => {
    const card = document.getElementById(`monitor-${monitor.id}`);

    // Delete button
    card.querySelector('.btn-delete').addEventListener('click', () => {
      deleteMonitor(monitor.id);
    });

    // Check now button
    card.querySelector('.btn-check').addEventListener('click', () => {
      checkNow(monitor.id);
    });

    // Interval select
    card.querySelector('.interval-select').addEventListener('change', (e) => {
      updateInterval(monitor.id, parseInt(e.target.value));
    });

    // Dismiss button (for changed monitors)
    const dismissBtn = card.querySelector('.btn-dismiss');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', () => {
        acknowledgeChange(monitor.id);
      });
    }
  });

  // Apply current filter
  applyFilter();
}

function renderMonitorCard(monitor) {
  const url = new URL(monitor.url);
  const hostname = url.hostname;
  const lastChecked = formatRelativeTime(monitor.lastChecked);
  const created = formatDate(monitor.createdAt);
  const hasChange = !!monitor.lastChangeDetected;

  const intervalOptions = INTERVAL_OPTIONS.map(opt =>
    `<option value="${opt.value}" ${opt.value === monitor.intervalMinutes ? 'selected' : ''}>${opt.label}</option>`
  ).join('');

  const changeBadge = hasChange ? `
    <span class="change-badge">
      Changed ${formatRelativeTime(monitor.lastChangeDetected)}
      <button class="btn btn-dismiss">Dismiss</button>
    </span>
  ` : '';

  return `
    <div class="monitor-card${hasChange ? ' changed' : ''}" id="monitor-${monitor.id}">
      <div class="monitor-header">
        <div>
          <a href="${monitor.url}" target="_blank" class="monitor-url" title="${monitor.url}">
            ${hostname}${url.pathname !== '/' ? url.pathname : ''}
          </a>
          ${changeBadge}
        </div>
        <div class="monitor-actions">
          <button class="btn btn-check">Check Now</button>
          <button class="btn btn-delete">Delete</button>
        </div>
      </div>

      <div class="monitor-selector" title="${monitor.selector}">
        ${escapeHtml(monitor.selector)}
      </div>

      ${monitor.elementPreview ? `
        <div class="monitor-preview">
          "${escapeHtml(monitor.elementPreview)}"
        </div>
      ` : ''}

      <div class="monitor-meta">
        <div class="monitor-meta-item">
          <span>⏱</span>
          <span>Check every:</span>
          <select class="interval-select">
            ${intervalOptions}
          </select>
        </div>

        <div class="monitor-meta-item">
          <span>🕐</span>
          <span data-last-checked="${monitor.id}">Last checked: ${lastChecked}</span>
        </div>

        <div class="monitor-meta-item">
          <span>📊</span>
          <span>Changes detected: ${monitor.changeCount}</span>
        </div>

        <div class="monitor-meta-item">
          <span>📅</span>
          <span>Added: ${created}</span>
        </div>

        <div class="monitor-meta-item">
          <span class="status-badge status-active">Active</span>
        </div>
      </div>
    </div>
  `;
}

function deleteMonitor(id) {
  if (!confirm('Are you sure you want to stop monitoring this element?')) {
    return;
  }

  chrome.runtime.sendMessage({ action: 'deleteMonitor', id }, (response) => {
    if (response && response.success) {
      showToast('Monitor deleted', 'success');
      loadMonitors();
    } else {
      showToast('Failed to delete monitor', 'error');
    }
  });
}

function checkNow(id) {
  showToast('Checking for changes...', '');

  chrome.runtime.sendMessage({ action: 'checkNow', id }, (response) => {
    if (response && response.success) {
      if (response.changed) {
        showToast('Change detected! Preview updated.', 'success');
      } else {
        showToast('No changes since last check', 'success');
      }
      loadMonitors();
    } else {
      showToast(response?.error || 'Failed to check', 'error');
      loadMonitors(); // Still refresh to update last checked time
    }
  });
}

function updateInterval(id, intervalMinutes) {
  chrome.runtime.sendMessage({
    action: 'updateMonitor',
    id,
    data: { intervalMinutes }
  }, (response) => {
    if (response && response.success) {
      showToast('Interval updated', 'success');
    } else {
      showToast('Failed to update interval', 'error');
    }
  });
}

function acknowledgeChange(id) {
  chrome.runtime.sendMessage({
    action: 'acknowledgeChange',
    id
  }, (response) => {
    if (response && response.success) {
      loadMonitors();
    } else {
      showToast('Failed to dismiss change', 'error');
    }
  });
}

function formatRelativeTime(timestamp) {
  const now = Date.now();
  const diff = now - timestamp;

  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  return `${days} day${days > 1 ? 's' : ''} ago`;
}

function formatDate(timestamp) {
  return new Date(timestamp).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function showToast(message, type) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast ${type} show`;

  setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}
