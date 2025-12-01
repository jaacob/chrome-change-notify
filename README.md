# DOM Change Monitor

A Chrome extension that monitors DOM elements for changes and sends system notifications when content changes. Similar to [Distill Web Monitor](https://distill.io/), but runs entirely locally.

## Features

- **Visual Element Selector** - Click on any element on a webpage to monitor it
- **Background Monitoring** - Checks continue even when you're not on the page
- **Per-Monitor Intervals** - Set different check frequencies (1 min to 1 day) for each monitor
- **System Notifications** - Receive macOS notifications when content changes
- **Badge Indicator** - Shows count of monitors on current page
- **JS-Rendered Content Support** - Works with React, Vue, and other SPA frameworks

## Installation

1. Clone this repository or download the source
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" (toggle in top right)
4. Click "Load unpacked"
5. Select the `chrome-change-notify` folder

## Usage

### Adding a Monitor

1. Navigate to the page you want to monitor
2. Click the extension icon in the toolbar
3. Click "Select Element to Monitor"
4. Hover over elements to highlight them, click to select
5. The element is now being monitored (default: every hour)

### Managing Monitors

- Click "Manage Monitors" or right-click the extension icon and select "Options"
- View all monitored elements with their current content preview
- Adjust check intervals per monitor
- Delete monitors you no longer need
- Click "Check Now" to manually trigger a check

### Check Intervals

- 1 minute
- 5 minutes
- 15 minutes
- 30 minutes
- 1 hour (default)
- 2 hours
- 6 hours
- 12 hours
- 1 day

## Architecture

This extension uses a "sticky window" architecture (similar to Distill Web Monitor) for checking JavaScript-rendered content:

- **Single minimized window** - One popup window stays minimized in your dock and is reused for all checks
- **Sequential processing** - Checks run one at a time through the same window to minimize resource usage
- **Queue system** - Multiple pending checks are queued and processed in order
- **Staggered scheduling** - After browser restart/wake, checks are staggered to prevent all monitors firing at once

### Why a Minimized Window?

Modern websites often render content with JavaScript (React, Vue, etc.). A simple `fetch()` request only gets the raw HTML before JavaScript runs. To see the actual rendered content, the page must load in a real browser context. This is a browser security constraint that all monitoring extensions face.

The minimized window approach:
- Allows JavaScript to execute and render content
- Stays out of your way (minimized in dock)
- Is reused for efficiency (not created/destroyed for each check)
- Closes automatically when all monitors are deleted

## Files

```
chrome-change-notify/
├── manifest.json      # Extension configuration
├── background.js      # Service worker (monitoring logic)
├── content.js         # Element selection UI
├── content.css        # Selection UI styles
├── popup.html/js      # Extension popup
├── manage.html/js     # Monitor management page
└── icons/             # Extension icons
```

## Permissions

- `storage` - Save monitor configurations
- `alarms` - Schedule periodic checks
- `notifications` - Show system notifications
- `activeTab` - Access current tab for element selection
- `scripting` - Inject scripts to extract element content
- `<all_urls>` - Monitor any website

## Limitations

- Monitors only run when Chrome is open
- Some sites may block or behave differently when loaded in background
- Dynamic class names (CSS modules, CSS-in-JS) may change between page loads
- Sites requiring login may need you to be logged in for checks to work

## Future Enhancements

Potential features for future versions:
- [ ] High-priority mode with more precise timing
- [ ] SMS notifications via Twilio integration
- [ ] Static/dynamic page toggle (use fetch for static pages)
- [ ] Export/import monitor configurations
- [ ] Change history log

## License

MIT
