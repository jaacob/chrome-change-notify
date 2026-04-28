# Changelog

## 1.12.x — Auction tracking & adaptive interval ramping

### 1.12.4 — Proactive tier-transition alarms

The 1.12.3 reschedule path only re-evaluated tiers when an alarm fired, so a monitor sitting in the 60-min tier wouldn't drop to the 5-min tier until its 60-min alarm fired — up to 60 minutes of lag. The UI showed "ramped" but the underlying `chrome.alarms` period stayed stale.

Now `scheduleMonitor` also creates one-shot alarms at each tier boundary:

- `tier60_<id>` fires at `expiresAt - 60min`
- `tier15_<id>` fires at `expiresAt - 15min`
- `tierexp_<id>` fires at `expiresAt`

Each one calls `rescheduleMonitor` on fire, which detects the period mismatch and recreates the main alarm at the new tier's interval. A 1-second slop past each boundary ensures the alarm lands inside the new tier rather than racing it.

`scheduleAllMonitors` runs on startup/install/update, so existing monitors with stale alarm periods self-heal on reload. The anti-snipe path also explicitly refreshes tier alarms when bumping `expiresAt` (since `rescheduleMonitor` would no-op when the tier doesn't change). `archiveMonitor` and `deleteMonitor` now clear all five alarm names via a `clearMonitorAlarms` helper.

### 1.12.3 — Performance: skip no-op reschedules

Previously, every check called `chrome.alarms.create` to recreate the monitor's alarm. With multiple monitors in the ramp window (1-min cadence) this churned the alarm system constantly and contributed to popup latency.

Now `rescheduleMonitor` compares the desired effective interval against the current alarm's `periodInMinutes` and short-circuits when they match. Alarms are only recreated on actual tier transitions and on anti-snipe extensions that cross a tier boundary.

### 1.12.2 — Parser robustness for embedded labels

Real auction pages embed labels in the same element as the date, e.g.

```html
<li>
  <b>Bidding Ends:</b>
  <div>Tue, Apr 28, 2026 at 01:07:30 pm CT</div>
</li>
```

`textContent` joins these with whitespace and newlines, and `Date.parse` chokes on several tokens. The parser now:

- Strips additional label prefixes: `Bidding Ends`, `Lot closes`, `Closing`, `Ending`
- Tries each line of multi-line text as a candidate, plus the tail after a colon
- Drops parser-hostile tokens before `Date.parse`: leading day-of-week names (`Tue,`), the word `at` between date and time, ambiguous timezone abbreviations (`CT`, `ET`, `PT`, `MT`)
- Collapses runs of whitespace

### 1.12.1 — Auto-fill `expiresAt` from picked text

When the user picks an auction-end-time element, the extension now tries to extract a future timestamp from the element's text and set `expiresAt` automatically.

Strategies, in order:

1. `Date.parse` on cleaned and raw text (handles full date+time strings)
2. Time-only formats (`3:00 PM`) — assumes today, rolls to tomorrow if past
3. Relative durations (`5h 23m`, `Ends in 2 hours`, `30 minutes remaining`)

If parsing fails, the monitor saves without an expiration and the user is prompted to set it manually. On the edit flow, `expiresAt` is only filled when currently null — never overwrites a value the user typed.

### 1.12.0 — Auction tracking & ramping

#### Adaptive interval ramping

Monitors with `expiresAt` set check more frequently as the deadline approaches:

| Time to expiry | Effective interval                      |
| -------------- | --------------------------------------- |
| > 60 min       | user-configured interval                |
| 15–60 min      | 5 min (or user interval, whichever ↓)   |
| < 15 min       | 1 min (or user interval, whichever ↓)   |
| Past expiry    | reverts to user interval (1h grace)     |

The user-configured interval is always a cap — ramping only ever shortens checks, never lengthens them.

#### Auction-end-time element tracking (anti-snipe)

A second optional element selector per monitor that points to the auction's displayed close time. On every check, that element's text is compared. When it changes, `expiresAt` is bumped by `extensionMinutes` (default 2). Designed for auction sites that delay close on late bids.

Picker UX:

- **Create flow**: after the primary element pick, an in-page banner appears — click the auction end-time element, or click "Save without auction tracking".
- **Edit flow**: a **Set element** button on each monitor card opens the URL in a new foreground tab and runs the picker there.

Both elements are extracted in a single page-load injection — no extra check overhead.

#### New monitor fields

```js
{
  auctionEndSelector: string | null,
  auctionEndSelectorPath: number[] | null,
  auctionEndContent: string | null,   // last-seen text, compared each check
  extensionMinutes: number            // default 2, range 1–60
}
```

No migration needed — falsy defaults are equivalent to "feature off" and existing code paths skip when unset.
