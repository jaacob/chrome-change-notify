let monitors = [];
let timestampInterval = null;
let isCheckingAll = false;
let currentFilter = 'all';
let archivedSearchQuery = '';
let archivedSectionExpanded = false;

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
  // Only filter active monitors (not archived ones)
  const monitorList = document.querySelector('.monitor-list');
  if (!monitorList) return;

  const cards = monitorList.querySelectorAll('.monitor-card');
  let visibleCount = 0;

  cards.forEach(card => {
    const isChanged = card.classList.contains('changed');
    const shouldShow = currentFilter === 'all' || (currentFilter === 'changed' && isChanged);

    card.style.display = shouldShow ? 'block' : 'none';
    if (shouldShow) visibleCount++;
  });

  // Show "no results" message if needed
  const existingNoResults = monitorList.querySelector('.no-results');

  if (existingNoResults) {
    existingNoResults.remove();
  }

  const activeMonitors = monitors.filter(m => !m.isArchived);
  if (visibleCount === 0 && activeMonitors.length > 0) {
    const noResults = document.createElement('div');
    noResults.className = 'no-results';
    noResults.textContent = currentFilter === 'changed'
      ? 'No changed monitors. All monitors are up to date!'
      : 'No monitors found.';
    monitorList.appendChild(noResults);
  }
}

function updateFilterCounts() {
  // Only count active (non-archived) monitors for filter tabs
  const activeMonitors = monitors.filter(m => !m.isArchived);
  const changedCount = activeMonitors.filter(m => m.lastChangeDetected).length;
  const totalCount = activeMonitors.length;

  document.getElementById('countAll').textContent = totalCount;
  document.getElementById('countChanged').textContent = changedCount;

  // Show/hide filter bar (only if there are active monitors)
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
    if (namespace === 'local') {
      // Handle check-all progress updates
      if (changes.checkAllProgress) {
        const progress = changes.checkAllProgress.newValue;
        if (progress) {
          updateProgressUI(progress);
        }
      }
      // Auto-refresh when monitors change (e.g., from background timer checks)
      if (changes.monitors && !isCheckingAll) {
        monitors = changes.monitors.newValue || [];
        renderMonitors(monitors);
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

  // Separate active and archived monitors
  const activeMonitors = monitors.filter(m => !m.isArchived);
  const archivedMonitors = monitors.filter(m => m.isArchived);

  // Filter archived monitors by search query
  const filteredArchivedMonitors = archivedMonitors.filter(m => {
    if (!archivedSearchQuery) return true;
    const query = archivedSearchQuery.toLowerCase();
    return m.url.toLowerCase().includes(query) ||
           m.selector.toLowerCase().includes(query) ||
           (m.elementPreview && m.elementPreview.toLowerCase().includes(query));
  });

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

  // Show the Check All button when there are active monitors
  checkAllBtn.style.display = activeMonitors.length > 0 ? 'block' : 'none';

  let html = '';

  // Active monitors section
  if (activeMonitors.length > 0) {
    html += `
      <div class="monitor-list">
        ${activeMonitors.map(monitor => renderMonitorCard(monitor, false)).join('')}
      </div>
    `;
  } else if (archivedMonitors.length > 0) {
    html += `
      <div class="empty-state" style="padding: 40px 20px;">
        <p>No active monitors. All monitors are archived.</p>
      </div>
    `;
  }

  // Archived monitors section
  if (archivedMonitors.length > 0) {
    html += `
      <div class="archived-section">
        <div class="archived-header" id="archivedHeader">
          <span class="archived-toggle">${archivedSectionExpanded ? '▼' : '▶'}</span>
          <span>Archived Monitors (${archivedMonitors.length})</span>
        </div>
        <div class="archived-content ${archivedSectionExpanded ? 'expanded' : ''}">
          <div class="archived-search">
            <input type="text" id="archivedSearchInput" placeholder="Search archived monitors..." value="${escapeHtml(archivedSearchQuery)}">
          </div>
          <div class="archived-list">
            ${filteredArchivedMonitors.length > 0 ?
              filteredArchivedMonitors.map(monitor => renderMonitorCard(monitor, true)).join('') :
              '<div class="no-results">No archived monitors match your search.</div>'
            }
          </div>
        </div>
      </div>
    `;
  }

  content.innerHTML = html;

  // Update filter counts
  updateFilterCounts();

  // Add event listeners for active monitors
  activeMonitors.forEach(monitor => {
    setupMonitorCardListeners(monitor, false);
  });

  // Add event listeners for archived monitors
  filteredArchivedMonitors.forEach(monitor => {
    setupMonitorCardListeners(monitor, true);
  });

  // Archived section toggle
  const archivedHeader = document.getElementById('archivedHeader');
  if (archivedHeader) {
    archivedHeader.addEventListener('click', () => {
      archivedSectionExpanded = !archivedSectionExpanded;
      renderMonitors(monitors);
    });
  }

  // Archived search input
  const searchInput = document.getElementById('archivedSearchInput');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      const cursorPos = e.target.selectionStart;
      archivedSearchQuery = e.target.value;
      renderMonitors(monitors);
      // Restore focus and cursor position after re-render
      const newInput = document.getElementById('archivedSearchInput');
      if (newInput) {
        newInput.focus();
        newInput.setSelectionRange(cursorPos, cursorPos);
      }
    });
  }

  // Apply current filter
  applyFilter();
}

function setupMonitorCardListeners(monitor, isArchived) {
  const card = document.getElementById(`monitor-${monitor.id}`);
  if (!card) return;

  // Delete button
  card.querySelector('.btn-delete').addEventListener('click', () => {
    deleteMonitor(monitor.id);
  });

  // Archive/Unarchive button
  const archiveBtn = card.querySelector('.btn-archive');
  if (archiveBtn) {
    archiveBtn.addEventListener('click', () => {
      if (isArchived) {
        unarchiveMonitor(monitor.id);
      } else {
        archiveMonitor(monitor.id);
      }
    });
  }

  // Check now button (only for active monitors)
  const checkBtn = card.querySelector('.btn-check');
  if (checkBtn) {
    checkBtn.addEventListener('click', () => {
      checkNow(monitor.id);
    });
  }

  // Interval select (only for active monitors)
  const intervalSelect = card.querySelector('.interval-select');
  if (intervalSelect) {
    intervalSelect.addEventListener('change', (e) => {
      updateInterval(monitor.id, parseInt(e.target.value));
    });
  }

  // Dismiss button (for changed monitors)
  const dismissBtn = card.querySelector('.btn-dismiss');
  if (dismissBtn) {
    dismissBtn.addEventListener('click', () => {
      acknowledgeChange(monitor.id);
    });
  }

  // History toggle
  const historyToggle = card.querySelector('.history-toggle');
  if (historyToggle) {
    historyToggle.addEventListener('click', () => {
      const historyContent = card.querySelector('.history-content');
      const toggleIcon = historyToggle.querySelector('.toggle-icon');
      if (historyContent) {
        historyContent.classList.toggle('expanded');
        toggleIcon.textContent = historyContent.classList.contains('expanded') ? '▼' : '▶';
      }
    });
  }
}

function renderChangeHistory(changeHistory) {
  if (!changeHistory || changeHistory.length === 0) {
    return '<div class="history-empty">No change history yet.</div>';
  }

  // Show history in reverse chronological order (newest first)
  const sortedHistory = [...changeHistory].reverse();

  return sortedHistory.map((entry, index) => {
    // The entry at sortedHistory[index] corresponds to changeHistory in reverse.
    // To find the predecessor, we need the chronologically previous entry.
    const chronoIndex = changeHistory.length - 1 - index;
    const prevEntry = chronoIndex > 0 ? changeHistory[chronoIndex - 1] : null;

    let valueHtml;
    if (prevEntry && prevEntry.content && entry.content) {
      valueHtml = `<div class="history-diff">${renderInlineDiff(prevEntry.content, entry.content)}</div>`;
    } else {
      valueHtml = `<div class="history-value">"${escapeHtml(entry.preview || entry.content.substring(0, 100))}"</div>`;
    }

    return `
      <div class="history-entry ${index === 0 ? 'latest' : ''}">
        <div class="history-timestamp">${formatDateTime(entry.timestamp)}</div>
        ${valueHtml}
      </div>
    `;
  }).join('');
}

// --- Word-level diff utilities ---

function tokenizeWords(text) {
  return text.split(/(\s+)/).filter(t => t.length > 0);
}

function computeWordDiff(oldText, newText) {
  const oldTokens = tokenizeWords(oldText);
  const newTokens = tokenizeWords(newText);

  // Trim common prefix and suffix to reduce DP matrix size
  let prefixLen = 0;
  while (prefixLen < oldTokens.length && prefixLen < newTokens.length &&
         oldTokens[prefixLen] === newTokens[prefixLen]) {
    prefixLen++;
  }

  let suffixLen = 0;
  while (suffixLen < (oldTokens.length - prefixLen) &&
         suffixLen < (newTokens.length - prefixLen) &&
         oldTokens[oldTokens.length - 1 - suffixLen] === newTokens[newTokens.length - 1 - suffixLen]) {
    suffixLen++;
  }

  const oldMiddle = oldTokens.slice(prefixLen, oldTokens.length - suffixLen);
  const newMiddle = newTokens.slice(prefixLen, newTokens.length - suffixLen);

  // LCS on the middle portion
  const ops = [];

  // Add common prefix
  for (let i = 0; i < prefixLen; i++) {
    ops.push({ type: 'equal', text: oldTokens[i] });
  }

  if (oldMiddle.length === 0 && newMiddle.length === 0) {
    // No changes in the middle
  } else if (oldMiddle.length * newMiddle.length > 4000000) {
    // Too large for DP — treat entire middle as remove+add
    if (oldMiddle.length > 0) {
      ops.push({ type: 'remove', text: oldMiddle.join('') });
    }
    if (newMiddle.length > 0) {
      ops.push({ type: 'add', text: newMiddle.join('') });
    }
  } else {
    // Standard DP LCS
    const m = oldMiddle.length;
    const n = newMiddle.length;
    const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (oldMiddle[i - 1] === newMiddle[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
    }

    // Backtrack to produce ops
    const middleOps = [];
    let i = m, j = n;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && oldMiddle[i - 1] === newMiddle[j - 1]) {
        middleOps.push({ type: 'equal', text: oldMiddle[i - 1] });
        i--; j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        middleOps.push({ type: 'add', text: newMiddle[j - 1] });
        j--;
      } else {
        middleOps.push({ type: 'remove', text: oldMiddle[i - 1] });
        i--;
      }
    }
    middleOps.reverse();

    // Merge consecutive ops of the same type
    for (const op of middleOps) {
      const last = ops[ops.length - 1];
      if (last && last.type === op.type) {
        last.text += op.text;
      } else {
        ops.push({ type: op.type, text: op.text });
      }
    }
  }

  // Add common suffix
  for (let i = oldTokens.length - suffixLen; i < oldTokens.length; i++) {
    const last = ops[ops.length - 1];
    if (last && last.type === 'equal') {
      last.text += oldTokens[i];
    } else {
      ops.push({ type: 'equal', text: oldTokens[i] });
    }
  }

  return ops;
}

function extractDiffContext(ops, contextWords) {
  if (contextWords === undefined) contextWords = 8;

  // Find which ops contain changes
  const changeIndices = [];
  ops.forEach((op, i) => {
    if (op.type !== 'equal') changeIndices.push(i);
  });

  if (changeIndices.length === 0) return ops;

  // For each equal op, decide if it should be kept, trimmed, or replaced with ellipsis
  const result = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].type !== 'equal') {
      result.push(ops[i]);
      continue;
    }

    // Find distance to nearest change
    const prevChange = changeIndices.filter(ci => ci < i);
    const nextChange = changeIndices.filter(ci => ci > i);
    const distPrev = prevChange.length > 0 ? i - prevChange[prevChange.length - 1] : Infinity;
    const distNext = nextChange.length > 0 ? nextChange[0] - i : Infinity;

    const words = ops[i].text.split(/(\s+)/).filter(t => t.length > 0);

    // Keep contextWords from the end (if near a following change) and start (if near a preceding change)
    let keepStart = distPrev <= 1 ? contextWords * 2 : 0; // words to keep from beginning
    let keepEnd = distNext <= 1 ? contextWords * 2 : 0;   // words to keep from end

    if (keepStart + keepEnd >= words.length) {
      // Keep entire block
      result.push(ops[i]);
    } else {
      // Trim and add ellipsis
      if (keepStart > 0) {
        result.push({ type: 'equal', text: words.slice(0, keepStart).join('') });
      }
      result.push({ type: 'ellipsis' });
      if (keepEnd > 0) {
        result.push({ type: 'equal', text: words.slice(words.length - keepEnd).join('') });
      }
    }
  }

  // Collapse adjacent ellipses
  const collapsed = [];
  for (const op of result) {
    if (op.type === 'ellipsis' && collapsed.length > 0 && collapsed[collapsed.length - 1].type === 'ellipsis') {
      continue;
    }
    collapsed.push(op);
  }

  return collapsed;
}

function renderDiffHtml(ops) {
  return ops.map(op => {
    if (op.type === 'equal') return `<span class="diff-equal">${escapeHtml(op.text)}</span>`;
    if (op.type === 'add') return `<span class="diff-add">${escapeHtml(op.text)}</span>`;
    if (op.type === 'remove') return `<span class="diff-remove">${escapeHtml(op.text)}</span>`;
    if (op.type === 'ellipsis') return `<span class="diff-ellipsis"> ... </span>`;
    return '';
  }).join('');
}

function renderInlineDiff(oldText, newText) {
  const ops = computeWordDiff(oldText, newText);
  const contextOps = extractDiffContext(ops);
  return renderDiffHtml(contextOps);
}

// --- End diff utilities ---

function renderMonitorCard(monitor, isArchived) {
  const url = new URL(monitor.url);
  const hostname = url.hostname;
  const lastChecked = formatRelativeTime(monitor.lastChecked);
  const created = formatDate(monitor.createdAt);
  const hasChange = !!monitor.lastChangeDetected;
  const historyCount = monitor.changeHistory ? monitor.changeHistory.length : 0;

  const intervalOptions = INTERVAL_OPTIONS.map(opt =>
    `<option value="${opt.value}" ${opt.value === monitor.intervalMinutes ? 'selected' : ''}>${opt.label}</option>`
  ).join('');

  const changeBadge = hasChange && !isArchived ? `
    <span class="change-badge">
      Changed ${formatRelativeTime(monitor.lastChangeDetected)}
      <button class="btn btn-dismiss">Dismiss</button>
    </span>
  ` : '';

  const statusBadge = isArchived
    ? '<span class="status-badge status-archived">Archived</span>'
    : '<span class="status-badge status-active">Active</span>';

  const archiveButtonText = isArchived ? 'Unarchive' : 'Archive';

  return `
    <div class="monitor-card${hasChange && !isArchived ? ' changed' : ''}${isArchived ? ' archived' : ''}" id="monitor-${monitor.id}">
      <div class="monitor-header">
        <div>
          <a href="${monitor.url}" target="_blank" class="monitor-url" title="${monitor.url}">
            ${hostname}${url.pathname !== '/' ? url.pathname : ''}
          </a>
          ${changeBadge}
        </div>
        <div class="monitor-actions">
          ${!isArchived ? '<button class="btn btn-check">Check Now</button>' : ''}
          <button class="btn btn-archive">${archiveButtonText}</button>
          <button class="btn btn-delete">Delete</button>
        </div>
      </div>

      <div class="monitor-selector" title="${monitor.selector}">
        ${escapeHtml(monitor.selector)}
      </div>

      ${monitor.previousContent && monitor.lastContent && monitor.lastChangeDetected && !isArchived ? `
        <div class="diff-container">
          ${renderInlineDiff(monitor.previousContent, monitor.lastContent)}
        </div>
      ` : monitor.elementPreview ? `
        <div class="monitor-preview">
          <div class="preview-current">
            "${escapeHtml(monitor.elementPreview)}"
          </div>
        </div>
      ` : ''}

      <!-- Change History -->
      <div class="history-section">
        <div class="history-toggle">
          <span class="toggle-icon">▶</span>
          <span>Change History (${historyCount} ${historyCount === 1 ? 'entry' : 'entries'})</span>
        </div>
        <div class="history-content">
          ${renderChangeHistory(monitor.changeHistory)}
        </div>
      </div>

      <div class="monitor-meta">
        ${!isArchived ? `
          <div class="monitor-meta-item">
            <span>⏱</span>
            <span>Check every:</span>
            <select class="interval-select">
              ${intervalOptions}
            </select>
          </div>
        ` : ''}

        <div class="monitor-meta-item">
          <span>🕐</span>
          <span data-last-checked="${monitor.id}">Last checked: ${lastChecked}</span>
        </div>

        <div class="monitor-meta-item">
          <span>📊</span>
          <span>Changes detected: ${monitor.changeCount || 0}</span>
        </div>

        <div class="monitor-meta-item">
          <span>📅</span>
          <span>Added: ${created}</span>
        </div>

        <div class="monitor-meta-item">
          ${statusBadge}
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

function archiveMonitor(id) {
  chrome.runtime.sendMessage({
    action: 'archiveMonitor',
    id
  }, (response) => {
    if (response && response.success) {
      showToast('Monitor archived', 'success');
      loadMonitors();
    } else {
      showToast('Failed to archive monitor', 'error');
    }
  });
}

function unarchiveMonitor(id) {
  chrome.runtime.sendMessage({
    action: 'unarchiveMonitor',
    id
  }, (response) => {
    if (response && response.success) {
      showToast('Monitor unarchived', 'success');
      loadMonitors();
    } else {
      showToast('Failed to unarchive monitor', 'error');
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

function formatDateTime(timestamp) {
  return new Date(timestamp).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
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
