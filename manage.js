let monitors = [];
let timestampInterval = null;

document.addEventListener('DOMContentLoaded', () => {
  loadMonitors();
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

  if (monitors.length === 0) {
    content.innerHTML = `
      <div class="empty-state">
        <div class="icon">🔍</div>
        <h2>No monitors yet</h2>
        <p>Click the extension icon on any page and select an element to start monitoring.</p>
      </div>
    `;
    return;
  }

  const html = `
    <div class="monitor-list">
      ${monitors.map(monitor => renderMonitorCard(monitor)).join('')}
    </div>
  `;

  content.innerHTML = html;

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
  });
}

function renderMonitorCard(monitor) {
  const url = new URL(monitor.url);
  const hostname = url.hostname;
  const lastChecked = formatRelativeTime(monitor.lastChecked);
  const created = formatDate(monitor.createdAt);

  const intervalOptions = INTERVAL_OPTIONS.map(opt =>
    `<option value="${opt.value}" ${opt.value === monitor.intervalMinutes ? 'selected' : ''}>${opt.label}</option>`
  ).join('');

  return `
    <div class="monitor-card" id="monitor-${monitor.id}">
      <div class="monitor-header">
        <a href="${monitor.url}" target="_blank" class="monitor-url" title="${monitor.url}">
          ${hostname}${url.pathname !== '/' ? url.pathname : ''}
        </a>
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
