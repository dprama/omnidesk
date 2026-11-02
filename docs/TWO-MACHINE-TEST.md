<!-- SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors -->
<!-- SPDX-License-Identifier: GPL-2.0-only -->

# Two-machine test: Windows PC + MacBook

About 20 minutes. Both computers on the same network. Tick each box, and for any ✗ note what you
did and what happened. At the end, send the two log files and the screenshots.

## 0. Install

**MacBook (Intel)**
1. Download `OmniDesk-2.5.0-mac-x64.dmg` from the website's Download button
   (https://dprama.github.io/omnidesk/). It should offer the Mac file and say 2.5.0.  ☐
2. Drag OmniDesk to Applications, then in Terminal:
   `xattr -dr com.apple.quarantine /Applications/OmniDesk.app`
3. Open OmniDesk. In System Settings → Privacy & Security, turn on OmniDesk under
   **Accessibility** and **Input Monitoring** (and **Screen Recording** for the second-screen test).
   Quit and reopen OmniDesk afterwards.
4. The status bar must not show "Engine stopped". If it does, click it and note the reason.  ☐

**Windows PC (x64)**
1. Open the same website on the PC: it should offer `OmniDesk-2.5.0-win-x64.exe`.  ☐
2. Run it. SmartScreen: **More info → Run anyway**. Accept the admin prompt (it adds the
   firewall rules and the virtual display driver). If it says to restart, restart.
3. Open OmniDesk. No "Engine stopped" in the status bar.  ☐

## 1. Pair
1. Mac: **Connection → Show a code here → Show a pairing code**.
2. PC: **Connection → Type a code**, pick the MacBook, type the 6 digits.
3. Both show the other device as connected, the status bar says "2 of 2 devices connected", and
   it says "Encrypted".  ☐
4. **Screen layout**: drag the MacBook to the side where it actually sits next to the PC's
   monitor.  ☐

## 2. Mouse and keyboard
| # | Do this | Expect | ✓/✗ |
|---|---|---|---|
| 2.1 | Push the PC pointer off the edge facing the Mac | Pointer appears on the Mac at about the same height | ☐ |
| 2.2 | Move it back | Returns to the PC | ☐ |
| 2.3 | On the Mac side, type in TextEdit using the PC keyboard: `Hello ÄÖ 123 @#` | Exactly that text, including the special characters | ☐ |
| 2.4 | Try Cmd/Ctrl+A, Backspace, arrow keys, Shift+arrows on the Mac | They work | ☐ |
| 2.5 | Hold the left button (drag a window) and push into the edge | Does **not** cross | ☐ |
| 2.6 | Cross, then immediately push back | Stays briefly (cooldown) rather than bouncing | ☐ |
| 2.7 | If the PC has two monitors: push into the edge **between** them | Moves to the other monitor, never to the Mac | ☐ |
| 2.8 | Push into an edge with nothing beyond it | Nothing happens; Mouse page shows the reason | ☐ |
| 2.9 | Start from the Mac trackpad toward the PC | Pointer goes to the PC; Mac keyboard types on the PC | ☐ |

## 3. Clipboard (both ways)
| # | Do this | Expect | ✓/✗ |
|---|---|---|---|
| 3.1 | Copy a sentence on the PC, paste on the Mac | Same text | ☐ |
| 3.2 | Copy a sentence on the Mac, paste on the PC | Same text | ☐ |
| 3.3 | Copy an image (screenshot to clipboard) on each side, paste on the other | The image | ☐ |
| 3.4 | Copy a file in Explorer, paste in Finder (and Finder → Explorer) | The file arrives | ☐ |
| 3.5 | Turn sharing off on the Clipboard page, copy again | Nothing reaches the other side | ☐ |

## 4. Second screen (optional today)
1. PC: **Second screen** → use the MacBook. The PC gets an extra monitor that shows on the Mac.  ☐
2. Mac: **Second screen** → use the PC. The Mac gets an extra display shown on the PC.  ☐

## 5. Send back
- Screenshots of: Home, Mouse page (with the screen map), Clipboard page — on both machines.
- The logs:
  - Mac: `~/Library/Application Support/OmniDesk/logs/omnidesk.log`
  - PC: `%APPDATA%\OmniDesk\logs\omnidesk.log` (paste that into the Explorer address bar)

The logs contain the start line (`start mode=… helper=…`), every crossing (`cross edge=…`) and every
refused push (`no-cross reason=…`), which is what I check against the boxes above. They contain no
clipboard contents.
