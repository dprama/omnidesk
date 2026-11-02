# Test window (mock backend, no engine)

- `node test/run.mjs --page mouse --shots test/shots/<agent>`: serves `renderer/` with `mock/omnidesk-mock.js` injected, opens headless Chrome, screenshots 1280×800, prints JSON, exits 1 on console errors, exceptions, CSP violations, failed requests or horizontal overflow.
- Flags: `--page <id>` (repeat) or `--all`; `--a11y` (keyboard-only walkthrough per page + 3-round leak check of subscriptions, timers, frames and listeners); `--phone` (400×860, honours the viewport meta); `--reduced-motion`; `--cmd "turn off clipboard"` (Ctrl+K, type, Enter, records the toast); `--scenario default|empty|offline|error`; `--headed` (visible window, stays open); `--timeout 20000`; `--root <dir>` (serve another renderer).
- Each run gets its own Chrome profile and port, so agents can run at the same time.
- `node test/serve.mjs [--root dir]`: just the server; open the printed URL in any browser. Add `?mock-scenario=offline` before the `#page`.
- `node --test test/`: unit tests for the mock (about 50 s; the cursor test waits for every decision reason).
- Mock hooks for tests only: `window.__omnideskMockCalls` (every API call), `window.__omnideskMock.stop()`, `window.__omnideskMock.subscriptions()` (live subscriber counts per channel).
- Cursor and decision coordinates are device-local (same space as that device's `screens`).
