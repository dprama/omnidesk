/*
 * Deskflow -- mouse and keyboard sharing utility
 * SPDX-FileCopyrightText: (C) 2026 Synergy App Ltd
 * SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
 * SPDX-License-Identifier: GPL-2.0-only WITH LicenseRef-OpenSSL-Exception
 */

#pragma once

#include "common/Enums.h"

#include <QString>

void ipcSendToClient(const QString &command, const QString &args = "");
void ipcSendConnectionState(deskflow::core::ConnectionState state);

//! Like ipcSendToClient(), but dropped instead of queued when no IPC client is connected
//! (used for `cursor=` and `clipboardItem=`, which are only useful live)
void ipcSendTransient(const QString &command, const QString &args);
