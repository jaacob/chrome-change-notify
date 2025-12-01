// Content script for DOM element selection

let selectionMode = false;
let highlightedElement = null;
let overlay = null;
let tooltip = null;

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startSelection') {
    startSelectionMode();
    sendResponse({ success: true });
  } else if (message.action === 'cancelSelection') {
    cancelSelectionMode();
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

  // Remove highlight
  if (highlightedElement) {
    highlightedElement = null;
  }

  // Remove event listeners
  document.removeEventListener('mousemove', handleMouseMove, true);
  document.removeEventListener('click', handleClick, true);
  document.removeEventListener('keydown', handleKeyDown, true);
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

function handleMouseMove(e) {
  if (!selectionMode) return;

  // Ignore our own elements
  if (e.target.id === 'dom-monitor-overlay' ||
      e.target.id === 'dom-monitor-tooltip' ||
      e.target.closest('#dom-monitor-overlay') ||
      e.target.closest('#dom-monitor-tooltip')) {
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

  // Ignore our own elements
  if (e.target.id === 'dom-monitor-overlay' ||
      e.target.id === 'dom-monitor-tooltip' ||
      e.target.closest('#dom-monitor-overlay') ||
      e.target.closest('#dom-monitor-tooltip')) {
    return;
  }

  e.preventDefault();
  e.stopPropagation();

  const element = highlightedElement || e.target;

  // Generate selector and path
  const selector = generateSelector(element);
  const path = generatePath(element);
  const content = element.textContent.trim();
  const preview = content.substring(0, 100) + (content.length > 100 ? '...' : '');

  // Send to background
  chrome.runtime.sendMessage({
    action: 'addMonitor',
    data: {
      url: window.location.href,
      selector: selector,
      selectorPath: path,
      elementPreview: preview,
      currentContent: content
    }
  }, (response) => {
    if (response && response.success) {
      showSuccessMessage();
    }
  });

  cancelSelectionMode();
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

function showSuccessMessage() {
  const msg = document.createElement('div');
  msg.id = 'dom-monitor-success';
  msg.innerHTML = '✓ Element added to monitor list';
  document.body.appendChild(msg);

  setTimeout(() => {
    msg.classList.add('fade-out');
    setTimeout(() => msg.remove(), 300);
  }, 2000);
}
