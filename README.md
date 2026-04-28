# DOM Change Monitor

A Chrome extension that monitors DOM elements for changes and sends system notifications when content changes. Similar to [Distill Web Monitor](https://distill.io/), but runs entirely locally.

## Features

- **Visual element selector** — click any element on a webpage to monitor it
- **Background monitoring** — checks continue while you browse
- **Per-monitor check intervals** — 1 minute up to 1 day
- **System notifications** — macOS notifications when content changes
- **Badge indicator** — shows monitor count for the current page
- **JS-rendered content support** — works with React, Vue, and other SPA frameworks
- **Change history** — full timeline of detected changes per monitor with inline diff highlighting
- **Notes** — free-form text per monitor
- **Archive / unarchive** — pause checking without deleting; archived monitors keep all data
- **Star** — pin important monitors to the top of the list
- **Search** — filter active and archived monitors by URL, title, selector, preview, or notes
- **Expiration dates** — set a deadline on a monitor; auto-archives 24h after expiration (1h grace for continued checking)
- **Adaptive interval ramping** — when expiration is set, check frequency automatically tightens as the deadline approaches (1-min cadence in the final 15 minutes)
- **Anti-snipe extension** — optionally pick a second element showing the auction's end time; when its text changes between checks, the expiration is automatically extended (for auction sites that delay close on late bids)

## Installation

1. Clone this repository or download the source
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" (toggle in top right)
4. Click "Load unpacked"
5. Select the `chrome-change-notify` folder

## Usage

### Adding a monitor

1. Navigate to the page you want to monitor
2. Click the extension icon in the toolbar
3. Click "Select Element to Monitor"
4. Hover to highlight, click to select
5. Optionally click a second element on the page to enable auction-end-time tracking, or click **Save without auction tracking**

### Managing monitors

Open the manage page via "Manage Monitors" in the popup or right-click → "Options". Each card lets you:

- Adjust the check interval
- Set or clear an expiration datetime
- Set, replace, or clear an auction-end-time element
- Adjust the anti-snipe extension minutes (default 2)
- Add notes
- Star, archive, or delete the monitor
- View the change history with inline diffs
- Manually trigger **Check Now** or **Check All Now**

### Adaptive ramping

When a monitor has an expiration date, check frequency tightens automatically:

| Time to expiry | Check every                              |
| -------------- | ---------------------------------------- |
| > 60 min       | user-configured interval                 |
| 15–60 min      | 5 min (or user interval, whichever ↓)    |
| < 15 min       | 1 min (or user interval, whichever ↓)    |
| Past expiry    | reverts to user interval (1h grace)      |

The user-configured interval is always a cap — ramping only ever shortens checks.

### Anti-snipe element tracking

For auction sites that extend the close time on late bids:

1. When creating a monitor, click the auction's end-time element (the one displaying the deadline)
2. The extension parses that text and pre-fills the expiration date
3. On every check, the element's text is re-read. If it changes, `expiresAt` is bumped by the configured minutes (default 2)

You can also add this to existing monitors via the **Set element** button on the manage page. The picker opens the monitor's URL in a new foreground tab.

## Architecture

The extension uses a "sticky window" approach (similar to Distill Web Monitor) for checking JavaScript-rendered content:

- **Single minimized window** — one popup window stays minimized and is reused for all checks
- **Sequential processing** — checks run one at a time through the same window to minimize resource usage
- **Queue system** — multiple pending checks are queued and processed in order
- **Staggered scheduling** — after browser restart/wake, checks are staggered to prevent all monitors firing at once

### Why a minimized window?

Modern websites render content with JavaScript. A `fetch()` only gets raw HTML before JS executes. To capture rendered content, the page must load in a real browser context. The minimized window:

- Allows JavaScript to execute and render content
- Stays out of your way (minimized in dock)
- Is reused for efficiency (not created/destroyed each check)
- Closes automatically when the last monitor is deleted

## Files

```
chrome-change-notify/
├── manifest.json      # Extension configuration
├── background.js      # Service worker: scheduling, ramping, parser, anti-snipe
├── content.js         # Element selection UI + multi-stage picker
├── content.css        # Selection UI styles
├── popup.html/js      # Extension popup
├── manage.html/js     # Monitor management page
├── CHANGELOG.md       # Version history
└── icons/             # Extension icons
```

## Permissions

- `storage` — save monitor configurations
- `alarms` — schedule periodic checks
- `notifications` — show system notifications
- `activeTab` — access current tab for element selection
- `scripting` — inject scripts to extract element content
- `<all_urls>` — monitor any website

## Limitations

- Monitors only run while Chrome is running
- Some sites block or behave differently when loaded in a background window
- Dynamic class names (CSS modules, CSS-in-JS) may change between page loads
- Sites requiring login need you to be logged in for checks to work
- The anti-snipe parser doesn't handle every date format (e.g., bare day-of-week without an explicit date) — falls back to manual expiration entry

## Future Enhancements

- [ ] High-priority mode with more precise timing
- [ ] SMS notifications via Twilio integration
- [ ] Static-page fast path (skip the sticky window for non-JS pages)
- [ ] Parallel checks via tab pool (for many monitors in the ramp window simultaneously)
- [ ] Poll-for-element-with-settle replacement for the fixed JS render delay
- [ ] Export/import monitor configurations

## License

MIT
