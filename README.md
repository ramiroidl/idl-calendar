# IDL Calendar

A dependency-free, read-only Home Assistant dashboard card, installable through
HACS. It shows an agenda from existing `calendar.*` entities using a minimal
black-and-white design: no animations, images, event editing, or service calls.

## Installation

1. Set up at least one calendar integration in Home Assistant.
2. In HACS, open **Custom repositories**, add
   `https://github.com/ramiroidl/idl-calendar`, and select **Dashboard**
   (called **Lovelace** or **Plugin** in older HACS versions).
3. Download **IDL Calendar**. If HACS does not register the resource automatically,
   add `/hacsfiles/idl-calendar/idl-calendar.js` as a **JavaScript module** in
   **Settings → Dashboards → Resources** (enable advanced mode if needed).
4. Add a manual card to a dashboard:

```yaml
type: custom:idl-calendar
title: Calendar
entities:
  - calendar.family
  - calendar.work
days: 7
max_events: 8
```

For manual installation, copy `idl-calendar.js` into `/config/www/` and register
`/local/idl-calendar.js` as a JavaScript module instead.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `entities` | Required | Non-empty list of Home Assistant calendar entity IDs. |
| `title` | `Calendar` | Heading text. |
| `days` | `7` | Calendar days to show, including today; integer from 1 to 14. |
| `max_events` | `8` | Maximum agenda entries; integer from 1 to 50. |
| `refresh_interval` | `300` | Refresh interval in seconds; integer from 60 to 86400. |
| `display_mode` | `responsive` | `responsive` for dashboards, `trmnl` for a fixed 800×480 canvas. |

Events are grouped by start day and sorted chronologically. All-day dates retain
their calendar date; timed events and the query window use the browser's local
timezone. Set the rendering browser's timezone to the intended display timezone.
Events that started before today and are still active appear under today.
Multi-day events appear once, not once per day. Calendar names appear when multiple
calendars are configured. Missing calendars show an error without hiding events
from calendars that are available; failed reads are retried at the next refresh.

## Low-resolution displays / TRMNL OG

Use `display_mode: trmnl` on a dedicated dashboard for the TRMNL OG's 800×480
landscape resolution. The card uses solid black text and rules on white,
high-contrast typography, and no interactive controls. The fixed canvas clips
content that does not fit; reduce `max_events`, shorten titles, or use a smaller
`days` window for busy calendars.

**This is a Home Assistant frontend card, not a native TRMNL plugin or a device
transport.** A TRMNL OG cannot execute a Lovelace JavaScript card directly.
To use it on the device, an external workflow must render the authenticated
dashboard in a browser, capture the card at 800×480, and send the image using your
TRMNL-supported image delivery setup. That capture/push workflow is not included.
Allow the card to finish loading before capturing. Keep Home Assistant private;
do not publish dashboards or embed access tokens in URLs or card configuration.

The card uses Home Assistant's existing authenticated `hass.callApi` connection
and only reads the calendar events endpoint. It does not store credentials.
Read-only here describes the card's behavior, not a restriction on the underlying
Home Assistant user's permissions.

## Development

No build step or runtime packages are needed; HACS serves the root JavaScript
module directly. With Node.js 22 or later, run the focused tests using `npm test`.
The tests use Node's built-in test runner; no package installation is required.