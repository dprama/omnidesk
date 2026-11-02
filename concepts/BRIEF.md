# OmniDesk UI concept: shared brief

You are building ONE interactive HTML concept of the OmniDesk desktop app. Four designers
build four concepts in parallel (ASCII, Aurora glass, Glass folders, Pixel), and the owner
picks one. All four must show the same app, pages and mock data, so the comparison is
about the look and feel only.

## Product

OmniDesk: "One desk for all your computers." A software KVM for Windows and macOS: one mouse,
one keyboard and one clipboard across computers, plus a laptop as a second screen. It's an
original product: do NOT mention or imitate TeamViewer, AnyDesk, Deskflow, Synergy or Barrier
anywhere except the About page credits (below). Original name, logo (draw your own simple
mark in inline SVG or CSS), icons (inline SVG) and copy.

## Design language (owner's words, applies to every concept, filtered through its style)

Dark, calm, Apple-like. Dark panels and a slow living spectral gradient behind everything.
Sidebar in groups, a live status bar, a command bar that glows while typing. Illustrations: a
minimal monochrome device kit (Windows PC, MacBook) and one calm animated scene per feature,
one accent color each. Not bright, not busy. Every page has its own live header. Respect
prefers-reduced-motion (stop all looping animation, keep the page fully readable).

## Feature accents (one hue per feature; adapt the exact values to your style)

Connection = cyan, Mouse & keyboard = violet, Clipboard = amber, Second screen = teal-green,
Camera = rose, Multi-device = blue. Semantic good/warn/bad colors are separate.

## Pages (all required, switchable from the sidebar; use #hash tokens: home, connection,
mouse, layout, clipboard, screen, camera, devices, tip, feedback, about)

Sidebar groups:
- (top) **Home**: dashboard with every device card (name, OS, link type, ping, battery for
  laptops, what is shared right now). Live header: real-looking ping + battery that tick.
- **Share**: Mouse & keyboard · Screen layout · Clipboard · Second screen · Camera
- **Devices**: Connection · Multi-device
- **More**: Tip · Feedback · About

Page specifics:
- **Connection**: live header = radar sweep finding devices. Pair a new device with a
  6-digit code (show code, countdown, "type this on the other computer"). Link type per
  device: Wi-Fi / USB cable / Bluetooth, with ping. Note "Encrypted, no account, no cloud".
- **Mouse & keyboard**: live header = screen map with a cursor moving across monitors and
  crossing to the other computer at the OUTER edge. Toggle on/off. Settings: cooldown after
  crossing (ms), arrival guard (ms), "Don't cross while a button is held" (locked on, shown as
  a rule), hotkey to lock the cursor. A small "Why didn't it cross?" log panel with lines like
  `12:04:31 no-cross reason=not-outer-edge edge=right pos=(2559,812) monitors=[0,0,2560x1440][2560,180,1920x1080]`.
- **Screen layout**: drag the device tiles (Windows PC with 2 monitors, MacBook with 1) to
  place them; snaps to edges; shows which edges cross.
- **Clipboard**: toggle; recent items shared (text, image thumbnail, file with size); which
  direction; "Files up to …" setting.
- **Second screen**: both directions: "Use MacBook as a screen for Windows PC" and "Use
  Windows PC as a screen for MacBook". Start/stop, resolution (1920×1080, 2560×1600),
  refresh 60 Hz, quality vs latency, measured latency (e.g. 38 ms over USB, 61 ms Wi-Fi).
  Calm scene: a display slides out of the PC onto the laptop.
- **Camera** (Multi-device mode): ONE switch "Share my camera with every device". Only one
  camera runs at a time (show which device's camera is live). "Watching now": list of devices
  watching. Small "Coming soon" badge is OK, but design the page fully.
- **Multi-device**: more than two devices on one desk (show 3: Windows PC, MacBook, and a
  third "Studio Mac mini" offline); mode switch.
- **Tip**: one-time tip jar style page (amounts $3/$5/$10, custom), warm thank-you copy. No
  real payment: the button shows a mock confirmation in-page.
- **Feedback**: type = Bug / Idea / Thank you; message; checkbox "Include system info" OFF by
  default; when ticked, show exactly what will be included (OS, app version 2.5.0, engine
  version, monitor layout, NO names/emails). Submit shows an in-page confirmation (no network).
- **About**: OmniDesk 2.5.0, "Licensed under GPL-2.0-only." Credits, verbatim facts:
  "Built on Deskflow (github.com/deskflow/deskflow). Copyright (C) 2025 Deskflow Developers,
  (C) 2012 Synergy App Ltd, (C) 2002 Chris Schoeneman." Plus "Second screen on Windows uses
  Virtual Display Driver (MIT)."

## Global UI

- **Status bar** (bottom, live): connected devices count, active device (where the cursor is
  now, which changes as the mouse header animates), clipboard on/off, link + ping, encryption lock.
- **Ctrl+K / Cmd+K command bar**: opens an overlay; fuzzy-filters commands; glows while
  typing; Enter runs. Commands must ACTUALLY change the mock state and the UI, for example:
  "Turn on clipboard" / "Turn off clipboard", "Turn mouse sharing on/off", "Start second screen
  on MacBook", "Stop second screen", "Share my camera", "Pair a new device" (goes to
  Connection and shows a code), "Go to <page>" for every page, "Lock cursor to this screen".
  Show a small toast after each action ("Clipboard is on"). Also a visible button in the UI
  that opens it, since a phone has no Ctrl+K.

## Mock data (use exactly these, so all concepts match)

- This device: "Windows PC": Windows 11, x64, 2 monitors (2560×1440 + 1920×1080 to its right,
  offset 180px down), wired Ethernet.
- "MacBook": macOS 15, Intel x64 (2018 MacBook Pro), 1 screen 2880×1800 (shown as 1440×900 points), battery
  starts 82% (slowly drains), link Wi-Fi ping ~4 ms (jitter 3–7), or USB cable ~1 ms.
- "Studio Mac mini": macOS 15, offline, last seen 2 days ago.
- Clipboard history: "Quarterly plan v3.docx" 2.4 MB (MacBook → PC), a screenshot PNG
  1440×900 (PC → MacBook), text "meet at 4:30, room B" (MacBook → PC).

## Technical rules (page contract; these are hard rules)

- Write ONE self-contained file. No `<!doctype>`, `<html>`, `<head>` or `<body>` tags: start
  with `<title>OmniDesk · <Concept></title>`, then
  `<meta name="claude:viewport-fit-sides" content="cover">`, then `<style>`, markup, `<script>`.
- External: only Google Fonts stylesheets (fonts.googleapis.com) with a real fallback stack.
  No other external requests, no images from the web; draw everything in SVG/CSS/canvas.
- Single dark look is allowed: set `color-scheme: dark` and every color as a token on bare
  `:root`, and an explicit `body` background.
- Desktop-first (an app window at ~1280×800), but must not scroll horizontally at 400px wide:
  sidebar collapses to a top bar or drawer, grids stack. Side gutter
  `padding-left: max(16px, env(safe-area-inset-left, 0px))` / right equivalent on the outer wrapper.
- No alert/confirm/prompt, no window.print, no form submission to anywhere, no localStorage
  required (if used, wrap in try/catch).
- Keyboard: visible focus states; Esc closes the command bar; the command bar is reachable by
  button too.
- `@media (prefers-reduced-motion: reduce)` disables looping animation and the gradient drift.
- Everything visible at rest (no opacity:0 waiting for scroll).
- Plain JS, no frameworks needed. Keep the code tidy: one state object, one render per page.
- Before finishing, extract the `<script>` contents and run `node --check` on them, and fix any
  error. Do not publish anything; just write the file and report back in under 120 words:
  file path, what the signature idea of your concept is, and anything you couldn't do.
