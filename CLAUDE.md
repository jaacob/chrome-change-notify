# Claude Code Guidelines for DOM Change Monitor

## Project Overview

This is a Chrome extension that monitors DOM elements for changes and sends system notifications. It's similar to Distill Web Monitor but runs entirely locally.

## Architecture

### Why a Sticky Window?

**This is the most important architectural decision to understand.**

Modern websites render content with JavaScript (React, Vue, etc.). A simple `fetch()` request only gets raw HTML before JS executes. To monitor JS-rendered content, we MUST load pages in a real browser context.

Options considered:
1. `fetch()` - Won't work for JS-rendered content
2. Offscreen documents - Can only load extension-internal pages, not arbitrary URLs
3. Creating/destroying windows per check - Wasteful, causes UI flicker
4. **Sticky window** - Single minimized window, reused for all checks ✓

This is how Distill Web Monitor does it. See: https://distill.io/docs/web-monitor/extensions-open-new-tab-for-checks/

### Key Files

- `background.js` - Service worker handling alarms, monitoring logic, sticky window management
- `content.js` - DOM element selection UI (injected into pages)
- `manage.js` - Management page logic
- `popup.js` - Extension popup logic

### Service Worker Persistence

Chrome terminates service workers when idle. The `stickyWindowId` variable resets on restart. **Solution**: Store window ID in `chrome.storage.local` and check both memory AND storage when looking for existing window.

```javascript
// CORRECT - check both memory and storage
if (stickyWindowId) { ... }
const stored = await chrome.storage.local.get(['stickyWindowId']);
if (stored.stickyWindowId) { ... }
```

### Queue System

All checks go through a sequential queue to:
1. Reuse the single sticky window
2. Prevent resource spikes after wake-from-sleep
3. Add delays between checks (1 second)

Alarm-triggered checks use `queueCheck()`. Manual "Check Now" calls `checkForChanges()` directly.

## Common Pitfalls

### 1. Don't Create Multiple Windows
Every check should reuse the same sticky window. Never create a new window per check.

### 2. Service Worker State Loss
Any in-memory variables (like `stickyWindowId`) will be lost when the service worker restarts. Persist important state to `chrome.storage.local`.

### 3. DOMParser Not Available
Service workers don't have `DOMParser`. That's why we use the sticky window approach - we inject scripts into real pages.

### 4. Chrome Window Positioning
Chrome doesn't allow windows positioned completely off-screen (`left: -10000` will error). Use `state: 'minimized'` instead.

### 5. Alarm Stampede After Sleep
When the computer wakes from sleep, all pending alarms fire at once. The queue system and staggered scheduling prevent this from overwhelming the system.

### 6. Notification requireInteraction on macOS
**Do NOT use `requireInteraction: true`** in `chrome.notifications.create()` options. On macOS, this causes notifications to silently fail - Chrome reports success but nothing appears. The notification will still work without this option, it just won't persist until clicked.

## Making Changes

### Adding a New Feature
1. Update relevant JS files
2. Bump version in `manifest.json` using semver:
   - PATCH (x.x.1): Bug fixes
   - MINOR (x.1.0): New features
   - MAJOR (1.0.0): Breaking changes
3. Commit with descriptive message
4. Push to GitHub

### Modifying the Check Logic
The check flow is:
1. `checkForChanges(monitorId)` - Main entry point
2. `ensureStickyWindow()` - Get/create the minimized window
3. Navigate tab to URL, wait for load + JS render delay
4. `chrome.scripting.executeScript()` - Inject `extractElementContent()`
5. Compare content, update storage, send notification if changed

### Storage Schema
```javascript
{
  monitors: [{
    id: string,
    url: string,
    pageTitle: string,                 // page title at time of monitor creation
    selector: string,
    selectorPath: number[],
    elementPreview: string,
    previousPreview: string | null,    // preview before last change (for showing delta)
    intervalMinutes: number,
    lastContent: string,
    previousContent: string | null,    // content before last change
    lastChecked: number,
    createdAt: number,
    changeCount: number,
    isDynamic: boolean,
    isArchived: boolean,               // true = monitor is archived (no checking, data preserved)
    isStarred: boolean,                // true = monitor is starred (sorts to top of list)
    expiresAt: number | null,          // timestamp (ms) when monitor expires and auto-archives, null = no expiration
    lastChangeDetected: number | null, // timestamp when change was detected, null after acknowledged
    changeHistory: [{                  // full history of all changes
      timestamp: number,
      content: string,
      preview: string
    }]
  }],
  stickyWindowId: number | null,
  checkAllProgress: {
    status: 'running' | 'complete',
    current: number,
    total: number,
    currentUrl: string,
    changedCount: number
  } | null
}
```

## Testing Checklist

When making changes, verify:
- [ ] Element selection works on various sites
- [ ] Check Now works (single monitor)
- [ ] Check All Now works with progress indicator
- [ ] Sticky window stays minimized and is reused
- [ ] Service worker restart doesn't break sticky window reuse
- [ ] Deleting all monitors closes the sticky window
- [ ] Badge shows correct count on monitored pages
- [ ] Notifications appear on macOS (with new content shown)
- [ ] Change history is recorded and displays correctly
- [ ] Archive/unarchive works (archived monitors stop checking)
- [ ] Archived section expands/collapses with search filtering
- [ ] Star/unstar works and starred monitors sort to top
- [ ] Expiration datetime can be set, cleared, and displays in Central Time
- [ ] Expired monitors auto-archive and stop checking
- [ ] Expiration countdown updates in real-time

## User Preferences

The user has expressed:
- Resource efficiency is paramount (don't tank the machine with 50 monitors)
- Timing precision is less important than stability
- Semantic versioning should be used
- Code should be clean and well-organized
- Future features may include: high-priority mode, SMS via Twilio
