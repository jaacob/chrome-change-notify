document.addEventListener('DOMContentLoaded', async () => {
  const selectBtn = document.getElementById('selectBtn');
  const manageBtn = document.getElementById('manageBtn');
  const status = document.getElementById('status');

  // Update status with monitor count and show current page monitors
  await updateStatus();

  selectBtn.addEventListener('click', async () => {
    // Get the active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab) {
      status.textContent = 'No active tab found';
      return;
    }

    // Check if we can inject into this tab
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      status.innerHTML = '<span style="color: #d93025">Cannot monitor Chrome internal pages</span>';
      return;
    }

    // Send message to content script to start selection
    try {
      await chrome.tabs.sendMessage(tab.id, { action: 'startSelection' });
      document.body.classList.add('selecting');

      // Close popup after a short delay
      setTimeout(() => {
        window.close();
      }, 500);
    } catch (error) {
      // Content script might not be loaded, try injecting it
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js']
        });
        await chrome.scripting.insertCSS({
          target: { tabId: tab.id },
          files: ['content.css']
        });

        // Try again
        await chrome.tabs.sendMessage(tab.id, { action: 'startSelection' });
        document.body.classList.add('selecting');

        setTimeout(() => {
          window.close();
        }, 500);
      } catch (e) {
        status.innerHTML = '<span style="color: #d93025">Cannot access this page</span>';
      }
    }
  });

  manageBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  async function updateStatus() {
    // Get current tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Get all monitors
    const result = await chrome.storage.local.get(['monitors']);
    const allMonitors = result.monitors || [];

    // Update total count
    const count = allMonitors.length;
    status.innerHTML = `Monitoring <strong>${count}</strong> element${count !== 1 ? 's' : ''} total`;

    // Show monitors for current page if any
    if (tab && tab.url) {
      const pageMonitors = allMonitors.filter(m => m.url === tab.url);

      if (pageMonitors.length > 0) {
        displayCurrentPageMonitors(pageMonitors);
      }
    }
  }

  function displayCurrentPageMonitors(monitors) {
    const section = document.getElementById('currentPageMonitors');
    const list = document.getElementById('monitorsList');

    list.innerHTML = monitors.map(monitor => `
      <div class="monitor-item" id="monitor-${monitor.id}">
        <div class="monitor-item-header">
          <div class="monitor-selector">${escapeHtml(monitor.selector)}</div>
          <button class="btn-delete-small" data-id="${monitor.id}">Delete</button>
        </div>
        ${monitor.elementPreview ? `<div class="monitor-preview">"${escapeHtml(monitor.elementPreview)}"</div>` : ''}
      </div>
    `).join('');

    section.style.display = 'block';

    // Add delete listeners
    monitors.forEach(monitor => {
      const deleteBtn = document.querySelector(`[data-id="${monitor.id}"]`);
      deleteBtn.addEventListener('click', async () => {
        await deleteMonitor(monitor.id);
      });
    });
  }

  async function deleteMonitor(id) {
    chrome.runtime.sendMessage({ action: 'deleteMonitor', id }, async (response) => {
      if (response && response.success) {
        // Refresh the display
        await updateStatus();
      }
    });
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
});
