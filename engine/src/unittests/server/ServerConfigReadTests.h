/*
 * Deskflow -- mouse and keyboard sharing utility
 * SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
 * SPDX-License-Identifier: GPL-2.0-only WITH LicenseRef-OpenSSL-Exception
 */

#include "arch/Arch.h"
#include "base/Log.h"

#include <QTemporaryDir>
#include <QTest>

// Reading back the server config the OmniDesk app writes (app/main/engine/config.js)
class ServerConfigReadTests : public QObject
{
  Q_OBJECT
private Q_SLOTS:
  void initTestCase();
  void appConfig_roundTrip();
  void appConfig_settingsDefaultsWhenNoOptionLines();
  void mouseButtonHotkey_survivesReadBack();

private:
  Arch m_arch;
  Log m_log;
  QTemporaryDir m_dir;
};
