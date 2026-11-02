/*
 * Deskflow -- mouse and keyboard sharing utility
 * SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
 * SPDX-License-Identifier: GPL-2.0-only WITH LicenseRef-OpenSSL-Exception
 */

#pragma once

#include <cstdint>

/**
 * @brief One monitor of a computer, in the computer's desktop coordinates
 *
 * Same coordinate space as IComputer::getShape() (the bounding box of all monitors).
 */
struct MonitorRect
{
  int32_t x = 0;
  int32_t y = 0;
  int32_t w = 0;
  int32_t h = 0;

  bool contains(int32_t px, int32_t py) const
  {
    return px >= x && px < x + w && py >= y && py < y + h;
  }

  bool operator==(const MonitorRect &) const = default;
};
