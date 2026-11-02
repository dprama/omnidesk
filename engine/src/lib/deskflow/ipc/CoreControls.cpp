/*
 * Deskflow -- mouse and keyboard sharing utility
 * SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
 * SPDX-License-Identifier: GPL-2.0-only WITH LicenseRef-OpenSSL-Exception
 */

#include "CoreControls.h"

#include <utility>

namespace deskflow::core::ipc {

CoreControls &CoreControls::instance()
{
  static CoreControls s_instance;
  return s_instance;
}

void CoreControls::setClipboard(bool on)
{
  std::scoped_lock lock(m_mutex);
  m_clipboard = on;
  changed();
}

void CoreControls::setMouseSharing(bool on)
{
  std::scoped_lock lock(m_mutex);
  m_mouseSharing = on;
  changed();
}

void CoreControls::setLockCursor(bool on)
{
  std::scoped_lock lock(m_mutex);
  m_lockCursor = on;
  changed();
}

std::optional<bool> CoreControls::clipboard() const
{
  std::scoped_lock lock(m_mutex);
  return m_clipboard;
}

bool CoreControls::mouseSharing() const
{
  std::scoped_lock lock(m_mutex);
  return m_mouseSharing.value_or(true);
}

std::optional<bool> CoreControls::lockCursor() const
{
  std::scoped_lock lock(m_mutex);
  return m_lockCursor;
}

void CoreControls::setPeerMonitors(const std::string &name, const std::vector<MonitorRect> &monitors)
{
  std::scoped_lock lock(m_mutex);
  if (monitors.empty()) {
    m_peerMonitors.erase(name);
  } else {
    m_peerMonitors[name] = monitors;
  }
}

std::vector<MonitorRect> CoreControls::peerMonitors(const std::string &name) const
{
  std::scoped_lock lock(m_mutex);
  if (const auto it = m_peerMonitors.find(name); it != m_peerMonitors.end()) {
    return it->second;
  }
  return {};
}

void CoreControls::setLocalMonitors(const std::vector<MonitorRect> &monitors)
{
  std::scoped_lock lock(m_mutex);
  m_localMonitors = monitors;
}

std::vector<MonitorRect> CoreControls::localMonitors() const
{
  std::scoped_lock lock(m_mutex);
  return m_localMonitors;
}

void CoreControls::setChangedCallback(std::function<void()> callback)
{
  std::scoped_lock lock(m_mutex);
  m_changed = std::move(callback);
}

void CoreControls::changed()
{
  // called with m_mutex held, so the callback can't be removed (and its owner
  // destroyed) while it runs. it must not call back into CoreControls.
  if (m_changed) {
    m_changed();
  }
}

} // namespace deskflow::core::ipc
