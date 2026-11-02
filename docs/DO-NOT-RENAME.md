# DO NOT RENAME: identifiers OmniDesk must keep

Scope: the Deskflow engine fork at `engine/` (upstream commit `2877600`). Every `file:line` below is
relative to `engine/` and was checked against the source on 2026-11-01.

**Rule for rebrand agents:** if an identifier is in a table below, leave it byte-for-byte as it is,
in code, CMake, installers and tests. The "Safe nearby" column says what you *may* change instead.

Decisions already made (from `OMNIDESK-ARCHITECTURE.md`): the engine keeps `kAppId = deskflow`
(CMake `project(deskflow)`), port 24800, the wire protocol, and bundle id `org.deskflow.deskflow`.

---

## 0. Read this first: three findings that change the plan

1. **`CMAKE_PROJECT_PROPER_NAME "Deskflow"` must stay too, not only `kAppId`.**
   `CMakeLists.txt:102` sets `CMAKE_PROJECT_PROPER_NAME "Deskflow"`, which becomes `kAppName`
   (`src/lib/common/Constants.h.in:10`). `kAppName`, not `kAppId`, decides the **settings folder, the
   `Deskflow.conf` file name, the portable-mode marker, the state file, the Windows service name, the
   Windows event-log source, the registry fallback and the `Global\DeskflowClose`/`SendSAS` events**
   (see §3 and §4). Changing it to "OmniDesk" silently gives existing users an empty config, a new TLS
   certificate (new fingerprint, so every peer has to re-trust), and no trusted devices.
   **Do it this way:** keep `CMAKE_PROJECT_PROPER_NAME "Deskflow"` in the engine. If the engine's own Qt
   UI text needs to say OmniDesk, add a new display-only constant (e.g. `kDisplayName`) and switch
   only the user-visible call sites (window titles, message boxes, status bar) to it.
2. **Trusted devices are not in `tls/deskflow.pem`.** `OMNIDESK-MAP.md` §6 says they are, but that file
   holds the local certificate and key. Trusted peers are in `tls/trusted-servers` and
   `tls/trusted-clients` (see §2). Pairing code must write to those two files.
3. **The core reads the layout from the main settings file, not only from `deskflow-server.conf`.**
   `Config::read` gets the computer list from `Settings::knownComputers()` (`src/lib/server/Config.cpp:448`).
   That function looks for `computer_<name>/…` groups in `Deskflow.conf` (`src/lib/common/Settings.cpp:550-560`).
   The `screens` and `aliases` sections in the server config are now ignored (`Config.cpp:630-644`, `716-727`).
   So OmniDesk's config-writer must write **both** files with the key names in §3 and §7.

---

## 1. Wire protocol (peers: Deskflow, Barrier, Input Leap, Synergy-protocol clients)

Who breaks: any peer machine. These bytes cross the network; a renamed code means the peer drops the
connection with `EBAD`/`EUNK` or silently ignores the message.

| Identifier / value | Defined at | Used at (main) | Why it can't change | Safe nearby |
|---|---|---|---|---|
| `kProtocolMajorVersion = 1` | `src/lib/deskflow/ProtocolTypes.h:37` | `client/Client.cpp:688`, `server/ClientProxyUnknown.cpp:234` | Peers refuse a different major version | Doc comments |
| `kProtocolMinorVersion = 8` | `ProtocolTypes.h:48` | `Client.cpp:695-701` (downgrade), `ClientProxy1_0`…`1_8` | Peers negotiate down to the lower minor. Raise it only with a new `ClientProxy1_9`/`ServerProxy1_9` pair, never rename or reuse values. | — |
| Hello protocol names `"Barrier"` / `"Synergy"` (exactly 7 chars) | `src/lib/common/NetworkProtocol.h:38,40` (names); options `"synergy"`/`"barrier"` at `:11-12` | Server sends `protocolString()+kMsgHelloArgs` (`server/Server.cpp:297-302`, `server/ClientProxyUnknown.cpp:43-44`); client parses at `Client.cpp:676-684` | Fixed-width `%7s` field. "OmniDesk" (8 chars) would break the framing, and peers only accept these two names | Radio-button labels in the Qt dialog |
| `kMsgHello = "%7s%2i%2i"` | `src/lib/deskflow/ProtocolTypes.cpp:12` | `Client.cpp:677` | Handshake format | — |
| `kMsgHelloArgs = "%2i%2i"` | `ProtocolTypes.cpp:13` | `ClientProxyUnknown.cpp:44` | Handshake format | — |
| `kMsgHelloBack = "%7s%2i%2i%s"` | `ProtocolTypes.cpp:14` | `ClientProxyUnknown.cpp:207` | Handshake format; trailing `%s` is the client's computer name, which must match a layout name | — |
| `kMsgHelloBackArgs = "%2i%2i%s"` | `ProtocolTypes.cpp:15` | `Client.cpp:720` | Handshake format | — |
| `kMaxHelloLength = 1024` | `ProtocolTypes.h:68` | `ClientProxyUnknown.cpp:199` | Limit peers rely on | — |
| Packet framing: 4-byte big-endian length prefix | `src/lib/deskflow/PacketStreamFilter.cpp:72-77` (write), `:112-115` (read) | every message | Peers frame the same way | — |
| `CNOP` `kMsgCNoop` | `ProtocolTypes.cpp:17` | — | Wire code | C++ constant names may change; string values may not |
| `CBYE` `kMsgCClose` | `:18` | | Wire code | |
| `CINN%2i%2i%4i%2i` `kMsgCEnter` | `:19` | `Server.cpp` switchComputer | Wire code + arg layout | |
| `COUT` `kMsgCLeave` | `:20` | | Wire code | |
| `CCLP%1i%4i` `kMsgCClipboard` | `:21` | | Wire code | |
| `CSEC%1i` `kMsgCScreenSaver` | `:22` | | Wire code | |
| `CROP` `kMsgCResetOptions` | `:23` | | Wire code | |
| `CIAK` `kMsgCInfoAck` | `:24` | | Wire code | |
| `CALV` `kMsgCKeepAlive` | `:25` | keep-alive; `kKeepAliveRate = 3.0` at `ProtocolTypes.h:80`, `kKeepAlivesUntilDeath = 3.0` at `:92` | Wire code; timing peers expect | |
| `DKDL%2i%2i%2i%s` `kMsgDKeyDown` (1.7+) | `:29` | | Wire code. The DKDN→DKDL oddity is deliberate (comment `:27-28`) | |
| `DKDN%2i%2i%2i` `kMsgDKeyDown1_1` | `:30` | | Wire code (≤1.6) | |
| `DKDN%2i%2i` `kMsgDKeyDown1_0` | `:31` | | Wire code (1.0) | |
| `DKRP%2i%2i%2i%2i%s` / `DKRP%2i%2i%2i%2i` / `DKRP%2i%2i%2i` | `:33-35` | | Wire code per version | |
| `DKUP%2i%2i%2i` / `DKUP%2i%2i` | `:36-37` | | Wire code per version | |
| `DMDN%1i` `kMsgDMouseDown` | `:38` | | Wire code | |
| `DMUP%1i` `kMsgDMouseUp` | `:39` | | Wire code | |
| `DMMV%2i%2i` `kMsgDMouseMove` | `:40` | | Wire code | |
| `DMRM%2i%2i` `kMsgDMouseRelMove` | `:41` | | Wire code | |
| `DMWM%2i%2i` / `DMWM%2i` (1.0) | `:42-43` | | Wire code | |
| `DCLP%1i%4i%1i%s` `kMsgDClipboard` | `:44` | `deskflow/ClipboardChunk.cpp:44-92` (chunk marks `DataStart=1`, `DataChunk=2`, `DataEnd=3` at `ProtocolTypes.h:160-162`) | Wire code + chunk mark values | |
| `DINF%2i%2i%2i%2i%2i%2i%2i` `kMsgDInfo` | `:45` | field order = `ClientInfo` (`ProtocolTypes.h:1339-1390`) | Wire code + field order | |
| `DSOP%4I` `kMsgDSetOptions` | `:46` | carries option IDs, see §1b | Wire code | |
| `DFTR%1i%s` `kMsgDFileTransfer` | `:47` | stubs today (`server/ClientProxy1_5.cpp`) | Wire code. OmniDesk's file clipboard must fill this in, not invent a new code | |
| `DDRG%2i%s` `kMsgDDragInfo` | `:48` | stubs | Wire code | |
| `SECN%s` `kMsgDSecureInputNotification` | `:49` | | Wire code | |
| `LSYN%s` `kMsgDLanguageSynchronisation` | `:50` | | Wire code | |
| `QINF` `kMsgQInfo` | `:51` | | Wire code | |
| `EICV%2i%2i` `kMsgEIncompatible` | `:52` | `ClientProxyUnknown.cpp:234` | Wire code | |
| `EBSY` `kMsgEBusy` | `:53` | | Wire code | |
| `EUNK` `kMsgEUnknown` | `:54` | | Wire code | |
| `EBAD` `kMsgEBad` | `:55` | `ClientProxyUnknown.cpp:238` | Wire code | |

### 1b. Values carried inside messages

| Identifier / value | Defined at | Why it can't change | Safe nearby |
|---|---|---|---|
| Option IDs sent in `DSOP`: `HDCL` `HDNL` `HDSL` `MMFS` `MMFC` `MMFA` `MMFG` `MMFM` `MMFR` `HART` `SSCM` `SSCS` `SSWT` `SSTT` `XTXU` `SFOC` `MDLT` `_KFW` `LTSS` `DLTS` `CLPS` `CLSZ` | `src/lib/deskflow/OptionTypes.h:38-59` | Client matches them in `client/ServerProxy.cpp` (e.g. `:787`). Unknown IDs are ignored, so the option would silently stop working | Constant names |
| Clipboard IDs `kClipboardClipboard=0`, `kClipboardSelection=1` | `src/lib/deskflow/ClipboardTypes.h:26-30` | Sent as `%1i` in CCLP/DCLP | — |
| Clipboard format order `Text`, `HTML`, `Bitmap` (enum index) | `src/lib/deskflow/IClipboard.h:49-55` | The marshalled clipboard carries the format index; reordering corrupts clipboard data between peers | Comments |
| Key IDs, button IDs, modifier masks | `src/lib/deskflow/KeyTypes.h`, `MouseTypes.h` | Numeric values on the wire (DKDN/DMDN…) | — |
| `PROTOCOL_MAX_MESSAGE_LENGTH` 4 MiB, list/string limits 1 MiB | `ProtocolTypes.h:120,130,140` | Peers drop larger messages | — |

---

## 2. Network and TLS (peers + existing trust)

| Identifier / value | Defined at | Used at | Why it can't change | Safe nearby |
|---|---|---|---|---|
| Default port `24800` | `ProtocolTypes.h:58` (`kDefaultPort`) **and** hard-coded again at `src/lib/common/Settings.cpp:356` (`core/port` default) | `deskflow/ServerApp.cpp:513`, `server/Config.cpp:557-561`, `gui/dialogs/SettingsDialog.ui:550` | Every Deskflow/Barrier/Synergy peer and firewall rule assumes it. If you ever change one, change both, but don't. | Port label text |
| TLS on/off must match on both sides (`security/tlsEnabled`, default true) | `Settings.h:101`, default true in `Settings.h:375` | `ServerApp.cpp:447-452`, `client/Client.cpp:64,429` | A TLS server and a plain-text client can't talk | — |
| `SecurityLevel` `PlainText` / `Encrypted` / `PeerAuth` | `src/lib/net/SecurityLevel.h:13-18` | `ServerApp.cpp:446-452`, `net/SecureSocket.cpp:433` | Local-only enum (not on the wire), but `PeerAuth` is what makes the server check `trusted-clients`. Keep the semantics | Enum may be renamed in code; behaviour must stay |
| Minimum TLS 1.2 (`SSL_OP_NO_TLSv1 \| SSL_OP_NO_TLSv1_1`) | `net/SecureSocket.cpp:356` | | Raising to 1.3-only would lock out older Deskflow peers | — |
| Fingerprint = **SHA-256 of the DER cert** | `net/SecureUtils.cpp:49-60`; checked at `SecureSocket.cpp:616-652` | | This is what peers stored when they trusted you | — |
| Trusted-DB line format `v2:sha256:<64 lowercase hex>` (also `v2:sha1:…` and legacy v1 `AA:BB:…` 59-char SHA-1) | `src/lib/net/Fingerprint.cpp:24-58`; type names `sha1`/`sha256` at `Fingerprint.h:16-17` | `FingerprintDatabase.cpp:22-69` (one per line, blank lines skipped) | Existing trust files on disk use this; OmniDesk's pairing writes it | — |
| Trusted servers DB file name `trusted-servers` | `src/lib/common/Settings.cpp:461-464` | Client side: `SecureSocket.cpp:496` (always checked when TLS is on) | Existing installs' trusted servers | — |
| Trusted clients DB file name `trusted-clients` | `Settings.cpp:466-469` | Server side, only when `PeerAuth`: `SecureSocket.cpp:433`; GUI `gui/MainWindow.cpp:1189` | Existing installs' trusted clients | — |
| TLS folder `<settingsPath>/tls` | `Settings.cpp:456-459` | above | Moves all trust and the cert | — |
| Local cert+key `tls/deskflow.pem` (from `kAppId`) | `Settings.cpp:334-335` (default of `security/certificate`) | `SecureSocket.cpp:459` | Renaming makes the engine generate a new cert, so **every peer sees a new fingerprint and must re-trust** | — |
| Cert subject `CN=Deskflow` | `net/SecureUtils.cpp:91` | — | Nobody checks the CN, but changing it only affects newly generated certs. Leave it to avoid confusion | Could change for new certs only (low value) |
| `security/keySize` default 2048 | `Settings.cpp:337-338` | | Fine to raise for new certs; never regenerate an existing cert as part of the rebrand | — |

---

## 3. Settings files, paths and keys (existing installs)

`kAppName` = `CMAKE_PROJECT_PROPER_NAME` = **"Deskflow"** (`CMakeLists.txt:102` → `Constants.h.in:10`).
`kAppId` = `CMAKE_PROJECT_NAME` = **"deskflow"** (`CMakeLists.txt:93-94` → `Constants.h.in:11`).

### 3a. Paths

| Path (resolved) | Defined at | Built from | Who breaks if renamed |
|---|---|---|---|
| Win user dir `%USERPROFILE%\AppData\Roaming\Deskflow` | `src/lib/common/Settings.h:24` | `kAppName` | Old installs' settings |
| Win system dir `C:\ProgramData\Deskflow` (**this is `settingsPath()` on Windows when not portable**, so tls/, server conf and daemon log live here) | `Settings.h:25`; `Settings.cpp:446-454` | `kAppName` | Trusted devices, cert, layout; the daemon (runs as SYSTEM) |
| macOS user dir `~/Library/Deskflow` (not Application Support) | `Settings.h:27` | `kAppName` | Old installs |
| macOS system dir `/Library/Deskflow` | `Settings.h:28` | `kAppName` | |
| Linux user dir `~/.config/Deskflow` | `Settings.h:30` | `kAppName` | |
| Linux system dir `/etc/Deskflow` | `Settings.h:31` | `kAppName` | |
| `$XDG_CONFIG_HOME/Deskflow/Deskflow.conf` (macOS + Linux, if the variable is set) | `Settings.cpp:79-80` | `kAppName` | |
| Settings file `<dir>/Deskflow.conf` (user, then system, load order at `Settings.cpp:72-86`) | `Settings.h:34-35` | `kAppName` | **All settings, layout and computer options** |
| Portable marker `<exe dir>/settings/Deskflow.conf` (its existence turns on portable mode) | `Settings.cpp:511-515`, check at `:435-439` | `kAppName` | Portable ZIP users; also written by `deploy/windows/pre-cpack.cmake.in:11` |
| State file `<GenericStateLocation or $XDG_STATE_HOME>/Deskflow.state` | `Settings.cpp:97-103` | `kAppName` | Window geometry, Wayland portal restore tokens (§3b) |
| Server config `<settingsPath>/deskflow-server.conf` | `Settings.cpp:352-353` | `kAppId` | Layout links + hotkeys; daemon and core read it |
| Core log default `~/deskflow.log` | `Settings.cpp:340-341` | `kAppId` | Users' log-tail scripts (low risk) |
| Daemon log `<settingsPath>/deskflow-daemon.log` | `Settings.cpp:366-367` | `kAppId` | Daemon; WiX removes old one at `deploy/windows/wix-patch.xml.in:20` |
| Registry fallback `HKCU\Software\Deskflow\Deskflow` (QSettings native, used when the proxy gets an empty file name) | `src/lib/common/QSettingsProxy.cpp:32` | `kAppName` ×2 | Any value stored there |
| Qt translations `deskflow_*.qm` in `share/deskflow/translations` | `src/lib/common/I18N.cpp:34-39,87,176`; files `translations/deskflow_*.ts` | `kAppId` | Translations stop loading (Qt UI only) |
| Icon theme `deskflow-light` / `deskflow-dark` | `src/lib/gui/StyleUtils.h:45-46`; `src/apps/res/icons/` | `kAppId` | Icons missing in Qt UI |
| Help file `share/doc/deskflow/HelpMain.md` | `src/lib/gui/MainWindow.cpp:1294` | `kAppId` | Qt help dialog |

Note: `deskflow-core --settings <file>` (`src/apps/deskflow-core/CoreArgs.h:20-21`, applied at
`CoreArgParser.cpp:51-52`) points the core at another settings file. On macOS/Linux `settingsPath()`
then follows that file, so `tls/` and `deskflow-server.conf` move with it. On Windows it stays
`C:\ProgramData\Deskflow`. OmniDesk should not pass a new path unless it also migrates `tls/`.

### 3b. Settings keys stored in `Deskflow.conf` (INI, `QSettings::IniFormat`)

All defined in `src/lib/common/Settings.h`. Old installs have these; the core reads many of them directly.
Safe nearby: the UI labels for them.

| Group | Keys (exact) | Lines |
|---|---|---|
| `client/` | `dynamicConnectionInterval` `invertYScroll` `invertXScroll` `yScrollScale` `xScrollScale` `languageSync` `remoteHost` `xdpClipboardRetried`\* `xdpRestoreToken`\* | `Settings.h:39-47` |
| `core/` | `coreMode` `interface` `lastVersion` `port` `preventSleep` `processMode` `computerName` `display` `useHooks` `language` `enableEnterCommand` `enterCommand` `enableExitCommand` `exitCommand` | `:51-64` |
| `daemon/` | `configFile` `elevate` `logFile` `logLevel` | `:68-71` |
| `gui/` | `autoHide` `startCoreWithGui` `enableUpdateCheck` `updateCheckUrl` `closeReminder` `closeToTray` `logExpanded` `symbolicTrayIcon` `windowGeometry`\* `shownFirstConnectedMessage` `shownServerFirstStartMessage` `showVersionInTitle` `ignoreMissingKeyboardLayouts` | `:75-87` |
| `log/` | `file` `level` `toFile` `guiDebug` | `:91-94` |
| `security/` | `checkPeerFingerprints` `certificate` `keySize` `tlsEnabled` | `:98-101` |
| `server/` | `clipboardSize` `defaultLockToComputerState` `disableLockToComputer` `enableClipboard` `enableHeartbeat` `enableSwitchDelay` `enableSwitchDoubleTap` `externalConfig` `externalConfigFile` `gridHeight` `gridWidth` `heartbeat` `protocol` (values `barrier`/`synergy`) `relativeMouseMoves` `switchDelay` `switchDoubleTap` `win32KeepForeground` `xdpClipboardRetried`\* `xdpRestoreToken`\* | `:105-123` |
| `computer_<name>/` | `aliases` `name` `halfDuplexCapsLock` `halfDuplexNumLock` `halfDuplexScrollLock` `modifierAlt` `modifierAltGr` `modifierCtrl` `modifierMeta` `modifierShift` `modifierSuper` `switchCornerSize` `switchCornerTopLeft` `switchCornerTopRight` `switchCornerBottomLeft` `switchCornerBottomRight` `weakX11Focus` `xtestIsXineramaUnaware` | `:128-145`; read by the core at `server/Config.cpp:48-100` |
| `internalConfig/` (layout grid) | arrays `screens` (item key `name`) and `hotkeys` (sub-array `actions` with `type` `typeScreenNames`/`typeScreenName` `switchScreenName` `switchInDirection` `lockCursorToScreen` `activeOnRelease` `hasScreens` `restartServer`, and `keys`/`key`) | `gui/config/ServerConfig.cpp:79-130`; `gui/config/Computer.cpp:24,59`; `common/Action.h:23-31`; `common/Hotkey.h:53`; `common/KeySequence.cpp:133-149` |
| Legacy keys still migrated | `core/screenName`, `internalConfig/numRows`, `numColumns`, `clipboardSharing`, `heartbeat`, `switchDelay`, `hasHeartbeat`, `hasSwitchDelay`, `hasSwitchDoubleTap`, `defaultLockToScreenState`, `disableLockToScreen`, `switchDoubleTap`, `win32KeepForeground`, `relativeMouseMoves`, `protocol`, `clipboardSharingSize`, `switchCorner` | `Settings.h:150-167, 391-429` |
| Valid groups list | `client core daemon gui log security server internalConfig` (anything else is cleaned out on load) | `Settings.h:264-273` |

\* stored in the state file, not `Deskflow.conf` (`Settings.h:382-388`). The `xdpRestoreToken` values are
Wayland portal grants: lose them and the user gets the Remote Desktop / Input Capture permission
prompt again.

Enum values written as ints: `ProcessMode {Service=0, Desktop=1}`, `CoreMode {None=0, Client=1, Server=2}`
(`Settings.h:176-189`). Don't reorder.

---

## 4. Package, process and OS-registration identifiers

| Identifier / value | Defined at | Used at | Why it can't change | Safe nearby |
|---|---|---|---|---|
| CMake `project(deskflow)` → `kAppId`, `CMAKE_PROJECT_NAME` | `CMakeLists.txt:93-94` | everything in §3 built from `kAppId`, binary names below | Decision: keep | `DESCRIPTION`, `HOMEPAGE_URL` (`:96-97`) |
| `CMAKE_PROJECT_PROPER_NAME "Deskflow"` → `kAppName` | `CMakeLists.txt:102`; `Constants.h.in:10,36-38` | see §0 and §3 | **Keep** (see §0) | `CMAKE_PROJECT_VENDOR`/`COPYRIGHT`/`CONTACT` (`:103-105`) are user-visible only |
| `CMAKE_PROJECT_REV_FQDN "org.deskflow.deskflow"` → `kRevFqdnName` | `CMakeLists.txt:106`; `Constants.h.in:15` | macOS `CFBundleIdentifier` via `src/apps/deskflow-gui/CMakeLists.txt:23`; `QGuiApplication::setDesktopFileName` `src/apps/deskflow-gui/deskflow-gui.cpp:63`; XDG portal `Register` `src/lib/platform/XDGPortalRegistry.h:39`; icon names `gui/MainWindow.cpp:86,736`, `gui/dialogs/AboutDialog.cpp:26`, `SettingsDialog.cpp:55-56` | macOS TCC (Accessibility/Input Monitoring) and Wayland portal grants are keyed on this id; desktop file must match | — |
| macOS bundle name `Deskflow.app` (target `Deskflow`) and Info.plist `CFBundleIdentifier`/`CFBundleExecutable` | `src/apps/deskflow-gui/CMakeLists.txt:5-9,20-24`; template `src/apps/res/deskflow.plist.in:7-14` | `cmake/MacCodesign.cmake:44` | Keep if an engine bundle ships at all. **OmniDesk.app gets its own bundle id: pick it once, never change it**, because TCC grants attach to the app that spawns `deskflow-core` | `NSLocalNetworkUsageDescription` text (`deskflow.plist.in:44`), `CFBundleGetInfoString`, copyright |
| macOS Info.plist keys `com.apple.security.networking.local`, `com.apple.security.accessibility` (read/write/execute) | `deskflow.plist.in:45-59` | | Local-network and accessibility permission prompts depend on them; copy them into OmniDesk.app's plist | — |
| `entitlements-dev.plist` (`disable-library-validation`, `get-task-allow`, `allow-jit`) | `src/apps/res/entitlements-dev.plist:4-6` | `cmake/MacCodesign.cmake:42` | Dev-only. Not used for release; not a TCC key | — |
| Linux desktop file `org.deskflow.deskflow.desktop` | `deploy/linux/org.deskflow.deskflow.desktop`; installed by `deploy/linux/deploy.cmake:10` | | Portal app-id lookup, launcher pins | `Name=`, `Comment=`, `Keywords=` (`:7-22`) |
| AppStream id `org.deskflow.deskflow`, `developer id="org.deskflow"`, launchable | `deploy/linux/org.deskflow.deskflow.metainfo.xml:3,7,24` | `deploy.cmake:25` | Software-centre identity and update path | `<name>`, `<summary>`, description, screenshots |
| Flatpak `app-id: org.deskflow.deskflow`, `command: deskflow` | `deploy/linux/flatpak/org.deskflow.deskflow.yml:1,5` | | Flatpak updates and stored permissions | — |
| Icons `org.deskflow.deskflow.png`, `org.deskflow.deskflow-symbolic.svg` | `deploy/linux/deploy.cmake:15,19` | `QIcon::fromTheme(kRevFqdnName)` | Name must equal app id | The artwork itself |
| Core binary `deskflow-core` / `deskflow-core.exe` (`kCoreBinName`) | `src/apps/deskflow-core/CMakeLists.txt:6`; `src/lib/common/CMakeLists.txt:4-7` → `Constants.h.in:23` | Daemon launches `<daemon dir>/deskflow-core.exe` (`src/apps/deskflow-daemon/DaemonApp.cpp:92-93`); GUI launches it (`gui/core/CoreProcess.cpp:106`); watchdog kill list (`platform/MSWindowsWatchdog.cpp:40-42`); firewall rules (`wix-patch.xml.in:24-25`) | Service, firewall rules and watchdog all match the file name. Must sit next to `deskflow-daemon.exe` | — |
| Daemon binary `deskflow-daemon` (`kDaemonBinName`) | `src/apps/deskflow-daemon/CMakeLists.txt:8`; `Constants.h.in:13` | WiX fragment id `CM_CP_deskflow_daemon.exe` (`wix-patch.xml.in:2`) | Windows service image path | — |
| GUI binary `deskflow` (Win/Linux), `Deskflow` (macOS) | `src/apps/deskflow-gui/CMakeLists.txt:5-9` | WiX `CloseApplication` `deskflow.exe` (`wix-patch.xml.in:47-52`), `RunDeskflow` (`:91-97`), `.desktop Exec=` | Only if the Qt GUI still ships | Retiring it is fine; renaming it while shipped breaks shortcuts |
| Legacy names `deskflow-server.exe`, `deskflow-client.exe` | `wix-patch.xml.in:59-70`; `MSWindowsWatchdog.cpp:40-41` | | Upgrades from pre-1.24 installs | — |
| Windows service name **`Deskflow`** (= `kAppName`) and DisplayName `Deskflow` | `deploy/windows/wix-patch.xml.in:5-6,19`; dispatcher name `src/lib/arch/win32/ArchDaemonWindows.cpp:65`; start/stop by name `:384-415` | | Existing service registration; install/uninstall/upgrade of the service | Service `Description` (`wix-patch.xml.in:7`); DisplayName could change only with a migration step |
| Firewall rules `Deskflow Server`, `Deskflow Client` → `[INSTALL_ROOT]deskflow-core.exe` | `wix-patch.xml.in:24-25` | | Rules are per program path; OmniDesk's NSIS installer must recreate the same program-path rule (names are display only) | Rule display names |
| WiX `CPACK_WIX_UPGRADE_GUID 027D1C8A-E7A5-4754-BB93-B2D45BFDBDC8` | `deploy/windows/deploy.cmake:40` | | Same GUID = MSI upgrades in place. Only matters if OmniDesk ever ships an MSI; an NSIS installer must instead detect and uninstall this product | — |
| Core IPC name `deskflow-core` (`kCoreIpcName`) | `Constants.h.in:24` | `deskflow/ipc/CoreIpcServer.cpp:18`; `gui/ipc/CoreIpcClient.cpp:15` | Electron connects here: Windows `\\.\pipe\deskflow-core`; macOS/Linux `QDir::tempPath()/deskflow-core` (`$TMPDIR` on macOS, `/tmp` on Linux) | — |
| Daemon IPC name `deskflow-daemon` (`kDaemonIpcName`) | `Constants.h.in:14` | `deskflow/ipc/DaemonIpcServer.cpp:20`; `gui/ipc/DaemonIpcClient.cpp:13` | Electron talks to the Windows service here: `\\.\pipe\deskflow-daemon` | — |
| Core single-instance shared memory key `deskflow-core` (`deskflow-core.exe` on Windows) | `src/apps/deskflow-core/deskflow-core.cpp:105` | `--new-instance` skips it (`CoreArgs.h:18-19`) | Two cores would fight over port 24800 | — |
| GUI single-instance key + local socket `deskflow-gui` | `src/apps/deskflow-gui/deskflow-gui.cpp:98-110` | | Only the Qt GUI | Free once the Qt GUI is retired |
| Windows events `Global\DeskflowClose`, `Global\DeskflowSendSAS` (from `kAppName`) | `Constants.h.in:37-38` | `deskflow/win32/AppUtilWindows.cpp:182`, `platform/MSWindowsProcess.cpp:140`, `platform/MSWindowsWatchdog.cpp:531`, `platform/MSWindowsKeyState.cpp:770` | Daemon (SYSTEM) ↔ core: graceful stop and Ctrl+Alt+Del (SAS). A daemon and core from different builds must agree | — |
| Window message `DeskflowDaemonExit` | `src/lib/arch/win32/ArchDaemonWindows.cpp:25` | | Daemon ↔ service host | — |
| Windows Event Log source `Deskflow` (`kAppName`) / syslog ident | `src/lib/base/Log.cpp:191` → `arch/win32/ArchLogWindows.cpp:25`, `arch/unix/ArchLogUnix.cpp:19` | | Existing event-viewer filters; low risk | — |
| Windows clipboard format `"Deskflow Ownership"` | `src/lib/platform/MSWindowsClipboard.cpp:212,221` | `MSWindowsComputer.cpp:351,1351` | Local only (marks "we wrote this"); must match between daemon-launched and user cores on one machine | — |
| Window classes `DeskflowDesk`, `kAppNameW` | `platform/MSWindowsDesks.cpp:395,664`; `MSWindowsComputer.cpp:112,787` | | Local only. Low risk, leave | — |
| Wayland portal shortcut ids `deskflow-hotkey-%08x-%08x` | `src/lib/platform/PortalGlobalShortcuts.cpp:516` | | The desktop stores the user's bindings under these ids; renaming re-prompts | Shortcut `description` text (`:117`) |
| libei client name `deskflow client` | `src/lib/platform/EiComputer.cpp:144-145` | | Compositors may show/remember it; low risk | — |

---

## 5. Local IPC commands (Electron ↔ core/daemon)

Transport: `QLocalServer`, world-accessible (`deskflow/ipc/IpcServer.cpp:34`), UTF-8 lines ending in `\n`,
`command=arg` split on `=` (`IpcServer.cpp:79-112`). Unknown commands are logged and ignored.

| Command | Direction | Defined at | Notes |
|---|---|---|---|
| `hello=<version>` → `hello=<version>` | client → server → client | `IpcServer.cpp:119-151`; client `gui/ipc/IpcClient.cpp:203-207` | **Version must match exactly**: `<kVersion>+<kVersionGitSha>`, e.g. `1.25.0.0+2877600` (`src/lib/common/VersionInfo.h.in:10-11`). Mismatch → `versionMismatch=<serverVersion>` (`IpcServer.cpp:137`). `deskflow-core --version` does **not** print this string on release builds (`kDisplayVersion`, `VersionInfo.h.in:12-14`), so OmniDesk must embed it at build time. After hello, queued messages are replayed (`:146-151`) |
| `noop` → `ok` | both servers | `IpcServer.cpp:152-154` | keep-alive |
| `error` / `error=<detail>` | server → client | `IpcServer.cpp:115,122`; `IpcClient.cpp:159-160` | |
| `bye` | core → client | `CoreIpcServer.cpp:36`; `IpcClient.cpp:142` | sent before core stops |
| `stop` → `ok` | client → core | `CoreIpcServer.cpp:33-38`; `CoreIpcClient.cpp:22` | the only core command today |
| `connectionState=<Disconnected\|Connecting\|Connected\|Listening>` | core → client | `deskflow/ipc/CoreIpc.cpp:24-27`; enum names `src/lib/common/Enums.h:38-44` | value is the enum **key name**; don't rename enum members |
| `connectedClients=<a,b,c>` | core → client | `server/Server.cpp:326` | |
| `unrecognisedClient=<name>` (British spelling) | core → client | `Server.cpp:257` | |
| `connectionRefused=<IncompatibleVersion\|AlreadyConnected\|UnknownClient\|ProtocolError>` | core → client | `client/Client.cpp:157`; enum `Enums.h:47-53` | enum key names |
| `retryIn=<seconds>` | core → client | `deskflow/ClientApp.cpp:164` | |
| `peerFingerprint=<64 uppercase hex, no colons>` | core → client | `net/SecureSocket.cpp:627-629` | what pairing UI compares |
| `secureSocket=<TLS version / cipher text>` | core → client | `net/SslLogger.cpp:103,107` | |
| `missingKeyboardLayouts=<list>` | core → client | `client/ServerProxy1_8.cpp:79` | |
| Client-side parser of all core messages | — | `gui/core/CoreProcess.cpp:627-666` | reference for the Electron port |
| `start` → `ok` | client → daemon | `deskflow/ipc/DaemonIpcServer.cpp:32-35`; `DaemonIpcClient.cpp:29` | |
| `stop` → `ok` | client → daemon | `DaemonIpcServer.cpp:36-39` | |
| `logLevel=<level>` → `ok`/`error` | client → daemon | `DaemonIpcServer.cpp:28-29,52-70`; `DaemonIpcClient.cpp:19` | |
| `configFile=<path to Deskflow.conf>` → `ok`/`error` | client → daemon | `DaemonIpcServer.cpp:30-31,72-90`; `DaemonIpcClient.cpp:24` | daemon reads `core/coreMode` and `daemon/elevate` from that file (`DaemonApp.cpp:78-80`) |
| `logPath` → `logPath=<file>` | client → daemon | `DaemonIpcServer.cpp:40-42`; `DaemonIpcClient.cpp:44,49` | |
| `clearSettings` → `ok` | client → daemon | `DaemonIpcServer.cpp:43-46`; `DaemonIpcClient.cpp:39` | |

Core command line (also an interface Electron uses): positional `server` | `client`
(`CoreArgParser.cpp:42-44`), `-s/--settings <file>`, `--new-instance`, `-h`, `-v` (`CoreArgs.h:16-21`).
The daemon runs `"<dir>\deskflow-core.exe" server|client --settings "<file>"` (`DaemonApp.cpp:93`).
Daemon flag: `-f/--foreground` (`src/apps/deskflow-daemon/deskflow-daemon.cpp:58`).
New OmniDesk commands (`clipboard`, `status`, `crossing`, `files`) should be **added**; never repurpose the names above.

---

## 6. URL schemes, MIME types, clipboard formats between peers

| Item | Status | Where |
|---|---|---|
| Custom URL scheme (`deskflow://` etc.) | **None exists.** No `CFBundleURLTypes`, no `x-scheme-handler`, no `MimeType=` in the desktop file | checked `deskflow.plist.in`, `org.deskflow.deskflow.desktop`, whole tree |
| Custom MIME type `application/x-deskflow-computer` | Local only: drag-and-drop inside the Qt layout editor. **Not exchanged with peers.** Safe to rename or drop | `src/lib/gui/ComputerSetupModel.cpp:18` |
| Clipboard data between peers | Not MIME-typed. Sent as the format index (§1b: Text=0, HTML=1, Bitmap=2) with UTF-8 / BMP payloads | `IClipboard.h:49-55` |
| OS clipboard format names | Standard OS names (`public.utf8-plain-text`, `public.html`, `text/html`, `UTF8_STRING`, …). Not branded; leave | `platform/OSXClipboard*Converter.cpp`, `platform/XWindowsClipboard.cpp:63-70` |

---

## 7. Server config file keywords (`deskflow-server.conf`)

Written by the Qt GUI (`gui/config/ServerConfig.cpp:158-184`) and by the core (`server/Config.cpp:1255-1281`);
read by the core (`Config.cpp:491-727`). Old config files contain these; OmniDesk's config-writer must emit them.

| Keyword | Defined at | Notes |
|---|---|---|
| `section:` header and `end` terminator | `Config.cpp:493,571,639,652,723` | |
| `section: links` | `Config.cpp:496`; parser `:646-714` | `<computer>:` lines, then `left`/`right`/`up`/`down` `= <computer>` with optional `(start,end)` percent ranges (`:681-697`; names `:471`) |
| `section: options` | `Config.cpp:494`; parser `:535-628` | Lines starting with `keystroke` or `mousebutton` are parsed (fixed for OmniDesk; upstream looked for `mousepress`), plus `omnideskCrossCooldown` / `omnideskArrivalGuard`; `address = …` is written (`:1274-1276`) but ignored on read. Other options come from `Deskflow.conf` (§3b) |
| `section: screens`, `section: aliases` | `Config.cpp:495,497` | Accepted but skipped with a warning (`:630-644`, `:716-727`). Still must parse, because old files have them |
| Conditions `keystroke(…)`, `mousebutton(…)`, `connect(…)` | `Config.cpp:733,743,753` | |
| Actions `keystroke` `keyDown` `keyUp` `mousebutton` `mouseDown` `mouseUp` `modifier` `switchToScreen` `switchInDirection(left\|right\|up\|down)` `switchToNextScreen` `lockCursorToScreen(off\|on\|toggle)` `restartServer(restart)` `keyboardBroadcast(off\|on\|toggle[,computers])` | `Config.cpp:778-925`; GUI names `common/Action.h:117-137`; writers `common/Hotkey.h:54-55`, `common/Hotkey.cpp:71-87` | "Screen" in these names is legacy wording. Keep it |
| Protocol option values `barrier` / `synergy` | `NetworkProtocol.h:11-12`; stored in `server/protocol` | |

Fixed in the OmniDesk fork: upstream's options reader looked for `mousepress` while the writers emit
`mousebutton(…)`, so mouse-button hotkeys were dropped on read-back (`ServerConfigReadTests`).

---

## 8. Other things a peer or an old install reads

| Identifier | Where | Why keep |
|---|---|---|
| Client computer name (sent in hello-back, matched to `computer_<name>` and links) | `Client.cpp:721`; `core/computerName` | Peers' layouts name this machine. Never derive it from the product name |
| `server/protocol` default `barrier` | `Settings.cpp:372-373`; `server/Server.h:423` | Default greeting old peers expect |
| Update check URL `https://api.deskflow.org/version` and `kOrgDomain "deskflow.org"` | `src/lib/common/UrlConstants.h:14,21`; `gui/updateCheckUrl` stored in old configs | Header comment says Qt uses `kOrgDomain` for settings paths "on some platforms". It feeds `setOrganizationDomain` (`deskflow-gui.cpp:62`). Leave in engine; OmniDesk does its own update check |
| `QCoreApplication` org/app name `Deskflow` / `Deskflow` | `src/apps/deskflow-gui/deskflow-gui.cpp:59-60` | Feeds Qt's default `QSettings` and `QStandardPaths` locations (e.g. `GenericStateLocation` users) |
| Core/daemon app names `Deskflow Core`, `Deskflow Daemon` | `deskflow-core.cpp:76`; `deskflow-daemon.cpp:42` | Feed Qt paths for those processes; keep with `kAppName` |
| Windows portable README + marker | `deploy/windows/pre-cpack.cmake.in:11-17` | Marker file name must stay `settings/Deskflow.conf` |
| Translations `translations/deskflow_*.ts` | `translations/` | File base name must equal `kAppId` (`I18N.cpp:87`) |

---

## Safe to rename (user-visible only)

Rebrand agents **may** change these, as long as nothing above is touched:

- **Window titles, dialog titles and message text** in the Qt UI (`gui/Messages.cpp`, `gui/widgets/StatusBar.cpp`,
  `gui/MainWindow.cpp:701-703,1061,1067`, `gui/dialogs/HelpDialog.cpp:78`). Route them through a new display-name
  constant; do not edit `kAppName` (§0).
- **About dialog text** (`gui/dialogs/AboutDialog.cpp:53` and the credits in `AboutDialog.h`). Credits for Deskflow,
  Synergy, Barrier/Input Leap and Chris Schoeneman stay (GPL-2.0-only).
- **Tray tooltip and tray menu labels**.
- **Installer display strings**: Start-menu folder, "Run … when finished" text, service *Description*,
  firewall rule *display* names, DMG volume name, `.desktop` `Name=`/`Comment=`, metainfo `<name>`/`<summary>`,
  `NSLocalNetworkUsageDescription`. (Not the ids, file names, GUIDs or service *name* listed in §4.)
- **Power/idle assertion reasons** shown by the OS: `platform/OSXPowerManager.cpp:19`, `OSXComputer.mm:804`,
  `XDGPowerManager.cpp:82` (if they go through a new display constant).
- **Docs** (`engine/docs/`, READMEs, help text, `src/apps/res/manpage.txt`).
- **Icons and artwork** (pixels only; keep the file names that equal `org.deskflow.deskflow` or `deskflow.*`).
- **C++ identifier names** (namespaces `deskflow::`, `isOwnedByDeskflow`, `DESKFLOW_MSG_*` macros) are internal
  and may be renamed, but it buys nothing and makes upstream merges harder. Recommendation: leave them.

**Must stay, always:** every `SPDX-FileCopyrightText` / `SPDX-License-Identifier` header, the `Copyright`
lines in `kCopyright` (`Constants.h.in:17-21`), `LICENSE`, `LICENSES/`, `REUSE.toml`. OmniDesk adds its own
copyright line; it never removes the Deskflow, Synergy, Nick Bolton or Chris Schoeneman ones.
