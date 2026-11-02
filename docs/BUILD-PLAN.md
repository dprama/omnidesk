# OmniDesk build plan

Design: Glass folders (`concepts/folders.html`, approved 2026-11-01). Architecture:
`OMNIDESK-ARCHITECTURE.md`. Never-rename list: `docs/DO-NOT-RENAME.md`.

## Repository layout and owners

Each path has exactly one owner. An agent edits only paths it owns; it may read anything.
If it needs a change in someone else's path, it writes the request in its final report.

| Owner (agent) | Owns | Job |
|---|---|---|
| **main** | `app/main/**` (except `pairing/`, `discovery/`, `screen/`), `app/preload/**`, `app/package.json`, `app/electron-builder.config.js` | Electron main: window + security, IPC handlers for the whole API below, core supervisor (spawn `deskflow-core`, log start mode + helper path), core IPC client, config writer, settings, logs, battery/ping. |
| **link** | `app/main/pairing/**`, `app/main/discovery/**` | 6-digit pairing (PAKE) that pins TLS fingerprints into the engine's trust files; mDNS discovery on every interface; link type (Wi-Fi/USB/Bluetooth/Ethernet) detection. |
| **shell** | `app/renderer/index.html`, `app/renderer/shell/**`, `app/renderer/styles/**`, `app/renderer/fonts/**` | Glass-folders frame: sidebar groups, folder tabs + stack, live status bar, Ctrl+K command bar and its registry, router, toasts, tokens, bundled fonts, CSP meta. |
| **pages-a** | `app/renderer/pages/{home,connection,devices,tip,feedback,about}.js` | Those pages. |
| **pages-b** | `app/renderer/pages/{mouse,layout,clipboard,screen,camera}.js` | Those pages. |
| **art** | `app/renderer/art/**` | Monochrome device kit (Windows PC, MacBook, Mac mini) + one calm animated scene per feature, reduced-motion aware. |
| **mock** | `app/mock/**`, `app/test/**` | Fake backend implementing the full API with realistic, moving data; the isolated test window (`npm run test-window -- --page mouse`). |
| **engine** | `engine/**` | Edge rules + rate-limited "why no crossing" log, start-up log line, new IPC commands, file clipboard. User-visible rebrand of strings only (respect DO-NOT-RENAME). |
| **screen** | `app/main/screen/**`, `native/macos-virtual-display/**`, `native/windows-vdd/**` | Second screen both ways: virtual monitor (VDD on Windows, Swift CGVirtualDisplay helper on Mac), capture, WebRTC stream over the paired link. |
| **site** | `site/**` | Website, strict CSP, Download button picks OS/arch from the latest GitHub release. |
| **ci** | `.github/**`, `build/**` | Workflows (tag `v*` → build engine + app per OS → upload to release), dmg background rendered from HTML, NSIS config inputs. |

Shared files nobody edits without the lead: `docs/API.md` (the contract), `docs/BUILD-PLAN.md`.

## Order

1. DO-NOT-RENAME list (done before any rename).
2. Contract `docs/API.md` (lead).
3. Wave 1, in parallel: mock, shell, art, main, engine, ci.
4. Wave 2, in parallel: pages-a, pages-b (need shell + mock + art), link, screen, site.
5. Review agents: input sharing, clipboard, second screen, camera, leftover old names. They fix what they find, still respecting ownership (a reviewer gets temporary ownership of the files it fixes, one reviewer per file).
6. Verification: every page in the test window with mock data; packaged app on the real Windows PC and MacBook.

## Testing rule

Every renderer agent tests only in its own test window with the mock backend
(`app/test/run.mjs --page <id> --shots <dir>`), never against the real engine, so agents
can't break each other. Each agent leaves screenshots of its pages in `app/test/shots/<agent>/`.

## Targets

- Windows: NSIS installer, x64 and arm64.
- macOS: .dmg for **Intel (x64) only** (owner's decision, 2026-11-01). The owner's MacBook is a 2018 Intel MacBook Pro. No Apple silicon build.
- Linux: AppImage x64.
- electron-builder `publish: 'never'`; CI uploads with `gh release upload`.
- Commits use `12533060+dprama@users.noreply.github.com` (repo-local config). Never the owner's private email.
