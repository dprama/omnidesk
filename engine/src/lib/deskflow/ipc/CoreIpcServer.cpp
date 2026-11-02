/*
 * Deskflow -- mouse and keyboard sharing utility
 * SPDX-FileCopyrightText: (C) 2025-2026 Synergy App Ltd
 * SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
 * SPDX-License-Identifier: GPL-2.0-only WITH LicenseRef-OpenSSL-Exception
 */

#include "CoreIpcServer.h"

#include "CoreControls.h"

#include "base/Log.h"
#include "base/OmniDeskLog.h"
#include "common/Constants.h"

#include <QLocalSocket>

namespace deskflow::core::ipc {

static CoreIpcServer *s_instance = nullptr;

CoreIpcServer::CoreIpcServer(QObject *parent) : IpcServer(parent, kCoreIpcName, QStringLiteral("core"))
{
  assert(s_instance == nullptr);
  s_instance = this;
}

CoreIpcServer &CoreIpcServer::instance()
{
  assert(s_instance != nullptr);
  return *s_instance;
}

void CoreIpcServer::processCommand(QLocalSocket *clientSocket, const QString &command, const QStringList &parts)
{
  // OmniDesk runtime switches: `clipboard=on|off`, `mouseSharing=on|off`, `lockCursor=on|off`
  // reply `ok`, or `error=<detail>` for a bad value
  if (command == QStringLiteral("clipboard") || command == QStringLiteral("mouseSharing") ||
      command == QStringLiteral("lockCursor")) {
    const auto value = parts.size() >= 2 ? parts.at(1).trimmed() : QString();
    if (value != QStringLiteral("on") && value != QStringLiteral("off")) {
      LOG_WARN("core ipc server got invalid %s value: %s", qPrintable(command), qPrintable(value));
      writeToClientSocket(clientSocket, QStringLiteral("error=expected %1=on|off").arg(command));
      return;
    }
    const bool on = (value == QStringLiteral("on"));
    LOG_INFO("ipc: %s %s", qPrintable(command), on ? "on" : "off");
    auto &controls = CoreControls::instance();
    if (command == QStringLiteral("clipboard")) {
      controls.setClipboard(on);
    } else if (command == QStringLiteral("mouseSharing")) {
      controls.setMouseSharing(on);
    } else {
      controls.setLockCursor(on);
    }
    writeToClientSocket(clientSocket, QStringLiteral("ok"));
    return;
  }

  // `peerMonitors=<screenName>:[x,y,WxH]...` (nothing after `:` clears) -> `ok` / `error=<detail>`
  if (command == QStringLiteral("peerMonitors")) {
    const auto arg = parts.size() >= 2 ? parts.mid(1).join('=') : QString();
    const auto colon = arg.indexOf(':');
    const auto name = colon > 0 ? arg.left(colon).trimmed() : QString();
    if (name.isEmpty()) {
      writeToClientSocket(clientSocket, QStringLiteral("error=expected peerMonitors=<screenName>:[x,y,WxH]..."));
      return;
    }
    const auto monitors = omnidesk::log::parseMonitors(arg.mid(colon + 1).trimmed().toStdString());
    if (!monitors.has_value()) {
      LOG_WARN("core ipc server got invalid peerMonitors: %s", qPrintable(arg));
      writeToClientSocket(clientSocket, QStringLiteral("error=invalid monitor list"));
      return;
    }
    CoreControls::instance().setPeerMonitors(name.toStdString(), *monitors);
    LOG_INFO(
        "ipc: peer monitors for \"%s\": %s", qPrintable(name),
        monitors->empty() ? "cleared" : omnidesk::log::formatMonitors(*monitors).c_str()
    );
    writeToClientSocket(clientSocket, QStringLiteral("ok"));
    return;
  }

  // `monitors?` -> `monitors=[x,y,WxH]...` (this computer, in its desktop coordinates;
  // empty until the core has enabled its screen)
  if (command == QStringLiteral("monitors?")) {
    const auto monitors = omnidesk::log::formatMonitors(CoreControls::instance().localMonitors());
    writeToClientSocket(clientSocket, QStringLiteral("monitors=%1").arg(QString::fromStdString(monitors)));
    return;
  }

  if (command == QStringLiteral("stop")) {
    LOG_DEBUG("core ipc server got stop message");
    writeToClientSocket(clientSocket, QStringLiteral("ok"));
    broadcastCommand(QStringLiteral("bye"));
    Q_EMIT stopProcessRequested();
    return;
  }
  LOG_WARN("core ipc server got unknown command: %s", command.toUtf8().constData());
}

} // namespace deskflow::core::ipc
