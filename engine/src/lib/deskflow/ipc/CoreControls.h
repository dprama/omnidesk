/*
 * Deskflow -- mouse and keyboard sharing utility
 * SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
 * SPDX-License-Identifier: GPL-2.0-only WITH LicenseRef-OpenSSL-Exception
 */

#pragma once

#include "base/MonitorRect.h"

#include <functional>
#include <map>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

namespace deskflow::core::ipc {

/**
 * @brief Runtime switches the OmniDesk app sets over the core's local IPC
 *
 * Written on the IPC (Qt main) thread by CoreIpcServer (`clipboard=on|off`,
 * `mouseSharing=on|off`, `lockCursor=on|off`, `peerMonitors=<name>:[...]`), read by
 * the server on the core thread. The core thread publishes this computer's own
 * monitors here for the `monitors?` query. Values that were never set are empty, so the config file decides.
 * The values survive a server restart inside the same core process.
 */
class CoreControls
{
public:
  static CoreControls &instance();

  void setClipboard(bool on);
  void setMouseSharing(bool on);
  void setLockCursor(bool on);

  std::optional<bool> clipboard() const;
  //! false only after the app sent `mouseSharing=off`
  bool mouseSharing() const;
  std::optional<bool> lockCursor() const;

  //! Monitors of client computer \p name in its own desktop coordinates; empty list clears
  void setPeerMonitors(const std::string &name, const std::vector<MonitorRect> &monitors);
  //! Empty if the app never sent them (the server then uses the client's bounding box)
  std::vector<MonitorRect> peerMonitors(const std::string &name) const;

  //! This computer's own monitors (set on the core thread when the screen is enabled or changes)
  void setLocalMonitors(const std::vector<MonitorRect> &monitors);
  std::vector<MonitorRect> localMonitors() const;

  //! Called after every change, on the thread that made it; pass {} to remove
  void setChangedCallback(std::function<void()> callback);

private:
  void changed();

  mutable std::mutex m_mutex;
  std::optional<bool> m_clipboard;
  std::optional<bool> m_mouseSharing;
  std::optional<bool> m_lockCursor;
  std::map<std::string, std::vector<MonitorRect>> m_peerMonitors;
  std::vector<MonitorRect> m_localMonitors;
  std::function<void()> m_changed;
};

} // namespace deskflow::core::ipc
