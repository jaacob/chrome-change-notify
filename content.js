// Content script for DOM element selection

let selectionMode = false;
let highlightedElement = null;
let overlay = null;
let tooltip = null;
let banner = null;
let monitorHighlights = []; // Track highlight overlays

// Picker state — drives whether the next click registers as primary,
// secondary (after primary on create), or auctionEnd (edit-flow remote pick).
let pickerStage = 'primary'; // 'primary' | 'awaitingSecondary' | 'auctionEnd'
let pickerMonitorId = null;
let primaryPickData = null;

// Color palette for highlighting multiple monitors
const HIGHLIGHT_COLORS = [
  '#e53935', // red
  '#8e24aa', // purple
  '#1e88e5', // blue
  '#43a047', // green
  '#fb8c00', // orange
  '#00acc1', // cyan
  '#d81b60', // pink
  '#5e35b1', // deep purple
];

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startSelection') {
    pickerStage = message.mode === 'auctionEnd' ? 'auctionEnd' : 'primary';
    pickerMonitorId = message.monitorId || null;
    primaryPickData = null;
    startSelectionMode();
    sendResponse({ success: true });
  } else if (message.action === 'cancelSelection') {
    cancelSelectionMode();
    sendResponse({ success: true });
  } else if (message.action === 'highlightMonitors') {
    highlightMonitors(message.monitors);
    sendResponse({ success: true });
  } else if (message.action === 'unhighlightMonitors') {
    unhighlightMonitors();
    sendResponse({ success: true });
  }
  return true;
});

function startSelectionMode() {
  if (selectionMode) return;

  selectionMode = true;
  document.body.classList.add('dom-monitor-selecting');

  // Create overlay for visual feedback
  createOverlay();
  createTooltip();

  // Add event listeners
  document.addEventListener('mousemove', handleMouseMove, true);
  document.addEventListener('click', handleClick, true);
  document.addEventListener('keydown', handleKeyDown, true);
}

function cancelSelectionMode() {
  if (!selectionMode) return;

  selectionMode = false;
  document.body.classList.remove('dom-monitor-selecting');

  // Remove overlay and tooltip
  if (overlay) {
    overlay.remove();
    overlay = null;
  }
  if (tooltip) {
    tooltip.remove();
    tooltip = null;
  }
  if (banner) {
    banner.remove();
    banner = null;
  }

  // Remove highlight
  if (highlightedElement) {
    highlightedElement = null;
  }

  // Remove event listeners
  document.removeEventListener('mousemove', handleMouseMove, true);
  document.removeEventListener('click', handleClick, true);
  document.removeEventListener('keydown', handleKeyDown, true);

  // Reset picker state
  pickerStage = 'primary';
  pickerMonitorId = null;
  primaryPickData = null;
}

function createOverlay() {
  overlay = document.createElement('div');
  overlay.id = 'dom-monitor-overlay';
  document.body.appendChild(overlay);
}

function createTooltip() {
  tooltip = document.createElement('div');
  tooltip.id = 'dom-monitor-tooltip';
  tooltip.innerHTML = 'Click to select element | Press ESC to cancel';
  document.body.appendChild(tooltip);
}

function isPickerOwnElement(target) {
  return (
    target.id === 'dom-monitor-overlay' ||
    target.id === 'dom-monitor-tooltip' ||
    target.id === 'dom-monitor-banner' ||
    target.closest('#dom-monitor-overlay') ||
    target.closest('#dom-monitor-tooltip') ||
    target.closest('#dom-monitor-banner')
  );
}

function handleMouseMove(e) {
  if (!selectionMode) return;

  // Ignore our own elements
  if (isPickerOwnElement(e.target)) {
    return;
  }

  highlightedElement = e.target;

  // Update overlay position
  const rect = e.target.getBoundingClientRect();
  overlay.style.top = rect.top + window.scrollY + 'px';
  overlay.style.left = rect.left + window.scrollX + 'px';
  overlay.style.width = rect.width + 'px';
  overlay.style.height = rect.height + 'px';
  overlay.style.display = 'block';

  // Update tooltip
  const selector = generateSelector(e.target);
  tooltip.innerHTML = `<strong>${e.target.tagName.toLowerCase()}</strong>${selector ? ` - ${selector}` : ''}<br>Click to select | ESC to cancel`;
  tooltip.style.top = (e.clientY + 15) + 'px';
  tooltip.style.left = (e.clientX + 15) + 'px';
}

function handleClick(e) {
  if (!selectionMode) return;

  // Clicks on our own UI (overlay/tooltip/banner) bypass the picker
  if (isPickerOwnElement(e.target)) {
    return;
  }

  e.preventDefault();
  e.stopPropagation();

  const element = highlightedElement || e.target;
  const selector = generateSelector(element);
  const path = generatePath(element);
  const content = element.textContent.trim();
  const preview = content.substring(0, 100) + (content.length > 100 ? '...' : '');

  if (pickerStage === 'auctionEnd') {
    const monitorId = pickerMonitorId;
    chrome.runtime.sendMessage({
      action: 'setAuctionEndElement',
      monitorId,
      data: { selector, selectorPath: path, text: content }
    }, (response) => {
      if (response && response.success) {
        const msg = response.parsedExpiresAt
          ? 'Auction tracking saved · expires ' + new Date(response.parsedExpiresAt).toLocaleString()
          : 'Auction tracking saved';
        showSuccessMessage(msg);
        // Tab was opened only for the picker; close it once we're done
        setTimeout(() => window.close(), 1500);
      }
    });
    cancelSelectionMode();
    return;
  }

  if (pickerStage === 'primary') {
    primaryPickData = {
      url: window.location.href,
      pageTitle: document.title,
      selector,
      selectorPath: path,
      elementPreview: preview,
      currentContent: content
    };
    pickerStage = 'awaitingSecondary';
    showSecondaryPickerBanner();
    return;
  }

  if (pickerStage === 'awaitingSecondary') {
    chrome.runtime.sendMessage({
      action: 'addMonitor',
      data: {
        ...primaryPickData,
        auctionEndSelector: selector,
        auctionEndSelectorPath: path,
        auctionEndText: content
      }
    }, (response) => {
      if (response && response.success) {
        const monitor = response.monitor || {};
        const msg = monitor.expiresAt
          ? 'Monitor added · expires ' + new Date(monitor.expiresAt).toLocaleString()
          : 'Monitor added · couldn’t auto-detect expiration, set manually';
        showSuccessMessage(msg);
      }
    });
    cancelSelectionMode();
  }
}

function saveWithoutAuctionTracking() {
  if (!primaryPickData) {
    cancelSelectionMode();
    return;
  }
  chrome.runtime.sendMessage({
    action: 'addMonitor',
    data: primaryPickData
  }, (response) => {
    if (response && response.success) {
      showSuccessMessage();
    }
  });
  cancelSelectionMode();
}

function showSecondaryPickerBanner() {
  if (banner) banner.remove();
  banner = document.createElement('div');
  banner.id = 'dom-monitor-banner';

  const text = document.createElement('div');
  text.className = 'dom-monitor-banner-text';
  const strong = document.createElement('strong');
  strong.textContent = 'Optional: ';
  text.appendChild(strong);
  text.appendChild(document.createTextNode(
    'click the auction end-time element to enable anti-snipe extension, or skip.'
  ));
  banner.appendChild(text);

  const skipBtn = document.createElement('button');
  skipBtn.id = 'dom-monitor-skip-btn';
  skipBtn.type = 'button';
  skipBtn.textContent = 'Save without auction tracking';
  skipBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    saveWithoutAuctionTracking();
  });
  banner.appendChild(skipBtn);

  document.body.appendChild(banner);

  if (tooltip) {
    tooltip.textContent = 'Click the auction end-time element, or use the Skip button (ESC to cancel)';
  }
}

function handleKeyDown(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    cancelSelectionMode();
  }
}

function generateSelector(element) {
  // Try to generate a unique CSS selector
  if (element.id) {
    return `#${element.id}`;
  }

  // Try class-based selector
  if (element.className && typeof element.className === 'string') {
    const classes = element.className.trim().split(/\s+/).filter(c => c && !c.startsWith('dom-monitor'));
    if (classes.length > 0) {
      const selector = element.tagName.toLowerCase() + '.' + classes.join('.');
      if (document.querySelectorAll(selector).length === 1) {
        return selector;
      }
    }
  }

  // Try nth-child approach
  const path = [];
  let current = element;

  while (current && current !== document.body && path.length < 5) {
    let selector = current.tagName.toLowerCase();

    if (current.id) {
      selector = `#${current.id}`;
      path.unshift(selector);
      break;
    }

    const parent = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
      if (siblings.length > 1) {
        const index = siblings.indexOf(current) + 1;
        selector += `:nth-of-type(${index})`;
      }
    }

    path.unshift(selector);
    current = parent;
  }

  return path.join(' > ');
}

function generatePath(element) {
  // Generate array of child indices from body to element
  const path = [];
  let current = element;

  while (current && current !== document.body) {
    const parent = current.parentElement;
    if (parent) {
      const index = Array.from(parent.children).indexOf(current);
      path.unshift(index);
    }
    current = parent;
  }

  return path;
}

function showSuccessMessage(text) {
  const msg = document.createElement('div');
  msg.id = 'dom-monitor-success';
  msg.textContent = '✓ ' + (text || 'Element added to monitor list');
  document.body.appendChild(msg);

  setTimeout(() => {
    msg.classList.add('fade-out');
    setTimeout(() => msg.remove(), 300);
  }, 2000);
}

// ============================================================================
// MONITOR HIGHLIGHTING
// ============================================================================

function highlightMonitors(monitors) {
  // Remove any existing highlights first
  unhighlightMonitors();

  monitors.forEach((monitor, index) => {
    const color = HIGHLIGHT_COLORS[index % HIGHLIGHT_COLORS.length];
    const element = findMonitoredElement(monitor);

    if (element) {
      createHighlightOverlay(element, monitor, color, index + 1);
    }
  });
}

function unhighlightMonitors() {
  monitorHighlights.forEach(highlight => {
    // Remove event listeners
    if (highlight.overlay && highlight.overlay._updatePosition) {
      window.removeEventListener('scroll', highlight.overlay._updatePosition, true);
      window.removeEventListener('resize', highlight.overlay._updatePosition);
    }
    if (highlight.overlay) highlight.overlay.remove();
    if (highlight.label) highlight.label.remove();
  });
  monitorHighlights = [];
}

function findMonitoredElement(monitor) {
  // Try selector first
  if (monitor.selector) {
    const element = document.querySelector(monitor.selector);
    if (element) return element;
  }

  // Fall back to selectorPath
  if (monitor.selectorPath) {
    return getElementByPath(monitor.selectorPath);
  }

  return null;
}

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

function createHighlightOverlay(element, monitor, color, number) {
  const rect = element.getBoundingClientRect();

  // Create overlay
  const overlay = document.createElement('div');
  overlay.className = 'dom-monitor-highlight-overlay';
  overlay.style.cssText = `
    position: fixed;
    top: ${rect.top}px;
    left: ${rect.left}px;
    width: ${rect.width}px;
    height: ${rect.height}px;
    border: 3px solid ${color};
    background: ${color}20;
    pointer-events: none;
    z-index: 2147483646;
    box-sizing: border-box;
  `;

  // Create label
  const label = document.createElement('div');
  label.className = 'dom-monitor-highlight-label';
  label.style.cssText = `
    position: fixed;
    top: ${Math.max(0, rect.top - 28)}px;
    left: ${rect.left}px;
    background: ${color};
    color: white;
    padding: 4px 8px;
    font-size: 12px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-weight: 600;
    border-radius: 4px;
    pointer-events: none;
    z-index: 2147483647;
    white-space: nowrap;
    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
  `;
  label.textContent = `#${number}: ${monitor.selector || 'Element'}`;

  document.body.appendChild(overlay);
  document.body.appendChild(label);

  monitorHighlights.push({ overlay, label, element });

  // Update position on scroll/resize
  const updatePosition = () => {
    const newRect = element.getBoundingClientRect();
    overlay.style.top = `${newRect.top}px`;
    overlay.style.left = `${newRect.left}px`;
    overlay.style.width = `${newRect.width}px`;
    overlay.style.height = `${newRect.height}px`;
    label.style.top = `${Math.max(0, newRect.top - 28)}px`;
    label.style.left = `${newRect.left}px`;
  };

  // Store the update function so we can remove it later
  overlay._updatePosition = updatePosition;
  window.addEventListener('scroll', updatePosition, true);
  window.addEventListener('resize', updatePosition);
}
