/*
 * Deskflow -- mouse and keyboard sharing utility
 * SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
 * SPDX-License-Identifier: GPL-2.0-only WITH LicenseRef-OpenSSL-Exception
 */

#pragma once

#include "base/DirectionTypes.h"
#include "base/MonitorRect.h"

#include <cstdint>
#include <cstdlib>
#include <optional>
#include <string>
#include <vector>

/**
 * @brief Machine-readable INFO lines the OmniDesk app parses from the core log
 *
 * The core logs each line with LOG_INFO("%s", line), so the log file shows
 * `[<timestamp>] INFO: <line>` (debug builds add a second line with file:line).
 * The app matches the text after `INFO: ` with these regexes (JavaScript syntax).
 * Change a format only together with the app's parser.
 *
 * Crossing refused (at most one line every 2 seconds, across all reasons):
 * @code
 * /^no-cross reason=(not-outer-edge|outside-zone|button-held|cooldown|arrival-guard|locked|sharing-off|no-neighbour) edge=(left|right|top|bottom) pos=\((-?\d+),(-?\d+)\) monitors=((?:\[-?\d+,-?\d+,\d+x\d+\])+)(?: remaining=(\d+)ms)?$/
 * @endcode
 * (app/main/engine/decisions.js uses these patterns verbatim; its test checks this comment).
 * Monitors: /\[(-?\d+),(-?\d+),(\d+)x(\d+)\]/g. `remaining=` is present only for reason=cooldown.
 *
 * Crossing made (every crossing, not rate limited):
 * @code
 * /^cross edge=(left|right|top|bottom) pos=\((-?\d+),(-?\d+)\) to=(.+) cooldown=(\d+)ms$/
 * @endcode
 *
 * Start-up (once per core process; helper may contain spaces):
 * @code
 * /^start mode=(server|client) helper=(.+) version=(\S+) pid=(\d+)$/
 * @endcode
 *
 * `pos` is the cursor position on the computer it is leaving, in that computer's desktop
 * coordinates (for a client screen: the position the server tracks for it).
 */
namespace omnidesk::log {

enum class NoCrossReason
{
  NotOuterEdge,
  OutsideZone,
  ButtonHeld,
  Cooldown,
  ArrivalGuard,
  Locked,
  SharingOff,
  NoNeighbour
};

inline const char *reasonName(NoCrossReason reason)
{
  switch (reason) {
    using enum NoCrossReason;
  case NotOuterEdge:
    return "not-outer-edge";
  case OutsideZone:
    return "outside-zone";
  case ButtonHeld:
    return "button-held";
  case Cooldown:
    return "cooldown";
  case ArrivalGuard:
    return "arrival-guard";
  case Locked:
    return "locked";
  case SharingOff:
    return "sharing-off";
  case NoNeighbour:
    return "no-neighbour";
  }
  return "no-neighbour";
}

inline const char *edgeName(Direction dir)
{
  switch (dir) {
    using enum Direction;
  case Left:
    return "left";
  case Right:
    return "right";
  case Top:
    return "top";
  case Bottom:
    return "bottom";
  default:
    return "none";
  }
}

inline std::string formatPos(int32_t x, int32_t y)
{
  return "(" + std::to_string(x) + "," + std::to_string(y) + ")";
}

inline std::string formatMonitors(const std::vector<MonitorRect> &monitors)
{
  std::string out;
  for (const auto &m : monitors) {
    out += "[" + std::to_string(m.x) + "," + std::to_string(m.y) + "," + std::to_string(m.w) + "x" +
           std::to_string(m.h) + "]";
  }
  return out;
}

//! Parse `[x,y,WxH][x,y,WxH]...` (as written by formatMonitors); empty text gives an empty list.
//! Returns nothing if the text is malformed or a size is not positive.
inline std::optional<std::vector<MonitorRect>> parseMonitors(const std::string &text)
{
  std::vector<MonitorRect> monitors;
  size_t i = 0;
  const auto readInt = [&text, &i](char end, int32_t &out) {
    const size_t stop = text.find(end, i);
    if (stop == std::string::npos || stop == i) {
      return false;
    }
    const std::string number = text.substr(i, stop - i);
    char *parsed = nullptr;
    const long value = std::strtol(number.c_str(), &parsed, 10);
    if (parsed == nullptr || *parsed != '\0' || value < INT32_MIN || value > INT32_MAX) {
      return false;
    }
    out = static_cast<int32_t>(value);
    i = stop + 1;
    return true;
  };
  while (i < text.size()) {
    if (text[i] != '[') {
      return std::nullopt;
    }
    ++i;
    MonitorRect m;
    if (!readInt(',', m.x) || !readInt(',', m.y) || !readInt('x', m.w) || !readInt(']', m.h) || m.w <= 0 ||
        m.h <= 0) {
      return std::nullopt;
    }
    monitors.push_back(m);
  }
  return monitors;
}

//! The first \p maxCodePoints code points of UTF-8 \p text, never cutting a character
//! (or, in UTF-16 terms, a surrogate pair) in half
inline std::string utf8Prefix(const std::string &text, size_t maxCodePoints)
{
  size_t count = 0;
  for (size_t i = 0; i < text.size(); ++i) {
    // a byte that is not a continuation byte (10xxxxxx) starts a code point
    if ((static_cast<unsigned char>(text[i]) & 0xC0) != 0x80) {
      if (count == maxCodePoints) {
        return text.substr(0, i);
      }
      ++count;
    }
  }
  return text;
}

//! `no-cross ...` line; \p remainingMs is only written for NoCrossReason::Cooldown
inline std::string formatNoCross(
    NoCrossReason reason, Direction edge, int32_t x, int32_t y, const std::vector<MonitorRect> &monitors,
    int64_t remainingMs = 0
)
{
  std::string line = std::string("no-cross reason=") + reasonName(reason) + " edge=" + edgeName(edge) +
                     " pos=" + formatPos(x, y) + " monitors=" + formatMonitors(monitors);
  if (reason == NoCrossReason::Cooldown) {
    line += " remaining=" + std::to_string(remainingMs) + "ms";
  }
  return line;
}

//! `cross ...` line
inline std::string formatCross(Direction edge, int32_t x, int32_t y, const std::string &to, int64_t cooldownMs)
{
  return std::string("cross edge=") + edgeName(edge) + " pos=" + formatPos(x, y) + " to=" + to +
         " cooldown=" + std::to_string(cooldownMs) + "ms";
}

//! `start ...` line
inline std::string
formatStart(const std::string &mode, const std::string &helper, const std::string &version, int64_t pid)
{
  return "start mode=" + mode + " helper=" + helper + " version=" + version + " pid=" + std::to_string(pid);
}

} // namespace omnidesk::log
