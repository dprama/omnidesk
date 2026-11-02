/*
 * Deskflow -- mouse and keyboard sharing utility
 * SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
 * SPDX-License-Identifier: GPL-2.0-only WITH LicenseRef-OpenSSL-Exception
 */

#include "server/EdgeRules.h"

#include <algorithm>
#include <chrono>
#include <limits>
#include <utility>

namespace deskflow::server {

namespace {

// index of the monitor holding x,y, else of the nearest one; -1 if there are none
int findMonitor(const std::vector<MonitorRect> &monitors, int32_t x, int32_t y)
{
  int best = -1;
  int64_t bestDistance = std::numeric_limits<int64_t>::max();
  for (int i = 0; i < static_cast<int>(monitors.size()); ++i) {
    const auto &m = monitors[i];
    if (m.w <= 0 || m.h <= 0) {
      continue;
    }
    if (m.contains(x, y)) {
      return i;
    }
    const int64_t dx = std::max<int64_t>({int64_t{m.x} - x, 0, int64_t{x} - (int64_t{m.x} + m.w - 1)});
    const int64_t dy = std::max<int64_t>({int64_t{m.y} - y, 0, int64_t{y} - (int64_t{m.y} + m.h - 1)});
    const int64_t distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

bool anyContains(const std::vector<MonitorRect> &monitors, int32_t x, int32_t y)
{
  return std::ranges::any_of(monitors, [x, y](const MonitorRect &m) { return m.contains(x, y); });
}

// is the dir edge of monitor m outer at the clamped point cx,cy?
bool isOuterAt(const std::vector<MonitorRect> &monitors, const MonitorRect &m, Direction dir, int32_t cx, int32_t cy)
{
  switch (dir) {
    using enum Direction;
  case Left:
    return !anyContains(monitors, m.x - 1, cy);
  case Right:
    return !anyContains(monitors, m.x + m.w, cy);
  case Top:
    return !anyContains(monitors, cx, m.y - 1);
  case Bottom:
    return !anyContains(monitors, cx, m.y + m.h);
  default:
    return false;
  }
}

int64_t steadyNowMs()
{
  using namespace std::chrono;
  return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

} // namespace

EdgeRules::EdgeRules(Clock clock) : m_clock(clock ? std::move(clock) : Clock(steadyNowMs))
{
  // do nothing
}

namespace {

EdgeHit classifyOn(const std::vector<MonitorRect> &monitors, int index, int32_t x, int32_t y, int32_t zoneSize);

} // namespace

EdgeHit EdgeRules::classify(const std::vector<MonitorRect> &monitors, int32_t x, int32_t y, int32_t zoneSize)
{
  return classifyOn(monitors, findMonitor(monitors, x, y), x, y, zoneSize);
}

EdgeHit EdgeRules::classify(
    const std::vector<MonitorRect> &monitors, int32_t x, int32_t y, int32_t zoneSize, int32_t fromX, int32_t fromY
)
{
  int index = -1;
  if (!anyContains(monitors, x, y)) {
    // off every monitor: use the monitor the cursor came from, if it was on one
    const auto from = std::ranges::find_if(monitors, [fromX, fromY](const MonitorRect &m) {
      return m.w > 0 && m.h > 0 && m.contains(fromX, fromY);
    });
    if (from != monitors.end()) {
      index = static_cast<int>(from - monitors.begin());
    }
  }
  if (index < 0) {
    index = findMonitor(monitors, x, y);
  }
  return classifyOn(monitors, index, x, y, zoneSize);
}

namespace {

EdgeHit classifyOn(const std::vector<MonitorRect> &monitors, int index, int32_t x, int32_t y, int32_t zoneSize)
{
  EdgeHit hit;
  hit.x = x;
  hit.y = y;

  if (index < 0) {
    return hit;
  }

  const auto &m = monitors[index];
  const int32_t zone = std::max(zoneSize, 1);
  const int32_t cx = std::clamp(x, m.x, m.x + m.w - 1);
  const int32_t cy = std::clamp(y, m.y, m.y + m.h - 1);
  hit.x = cx;
  hit.y = cy;

  using enum Direction;
  if (cx < m.x + zone) {
    hit.horizontal = Left;
  } else if (cx >= m.x + m.w - zone) {
    hit.horizontal = Right;
  }
  if (cy < m.y + zone) {
    hit.vertical = Top;
  } else if (cy >= m.y + m.h - zone) {
    hit.vertical = Bottom;
  }

  if (hit.horizontal != NoDirection) {
    hit.horizontalOuter = isOuterAt(monitors, m, hit.horizontal, cx, cy);
  }
  if (hit.vertical != NoDirection) {
    hit.verticalOuter = isOuterAt(monitors, m, hit.vertical, cx, cy);
  }
  return hit;
}

} // namespace

bool EdgeRules::isOuterEdge(const std::vector<MonitorRect> &monitors, Direction dir, int32_t x, int32_t y)
{
  const int index = findMonitor(monitors, x, y);
  if (index < 0) {
    return false;
  }
  const auto &m = monitors[index];
  return isOuterAt(monitors, m, dir, std::clamp(x, m.x, m.x + m.w - 1), std::clamp(y, m.y, m.y + m.h - 1));
}

MoveStep EdgeRules::moveOnMonitors(
    const std::vector<MonitorRect> &monitors, int32_t oldX, int32_t oldY, int32_t newX, int32_t newY
)
{
  MoveStep step;
  step.x = newX;
  step.y = newY;
  if (anyContains(monitors, newX, newY)) {
    return step;
  }

  const int index = findMonitor(monitors, oldX, oldY);
  if (index < 0) {
    return step;
  }
  const auto &m = monitors[index];
  step.x = std::clamp(newX, m.x, m.x + m.w - 1);
  step.y = std::clamp(newY, m.y, m.y + m.h - 1);

  using enum Direction;
  Direction horizontal = NoDirection;
  if (newX < m.x) {
    horizontal = Left;
  } else if (newX > m.x + m.w - 1) {
    horizontal = Right;
  }
  Direction vertical = NoDirection;
  if (newY < m.y) {
    vertical = Top;
  } else if (newY > m.y + m.h - 1) {
    vertical = Bottom;
  }

  for (const Direction dir : {horizontal, vertical}) {
    if (dir != NoDirection && isOuterAt(monitors, m, dir, step.x, step.y)) {
      step.leaves = true;
      step.dir = dir;
      return step;
    }
  }
  return step;
}

Direction EdgeRules::opposite(Direction dir)
{
  switch (dir) {
    using enum Direction;
  case Left:
    return Right;
  case Right:
    return Left;
  case Top:
    return Bottom;
  case Bottom:
    return Top;
  default:
    return NoDirection;
  }
}

MonitorRect EdgeRules::boundingBox(const std::vector<MonitorRect> &monitors)
{
  if (monitors.empty()) {
    return {};
  }
  int64_t x0 = std::numeric_limits<int64_t>::max();
  int64_t y0 = std::numeric_limits<int64_t>::max();
  int64_t x1 = std::numeric_limits<int64_t>::min();
  int64_t y1 = std::numeric_limits<int64_t>::min();
  for (const auto &m : monitors) {
    x0 = std::min<int64_t>(x0, m.x);
    y0 = std::min<int64_t>(y0, m.y);
    x1 = std::max<int64_t>(x1, int64_t{m.x} + m.w);
    y1 = std::max<int64_t>(y1, int64_t{m.y} + m.h);
  }
  return MonitorRect{
      static_cast<int32_t>(x0), static_cast<int32_t>(y0), static_cast<int32_t>(x1 - x0), static_cast<int32_t>(y1 - y0)
  };
}

void EdgeRules::setCooldownMs(int64_t ms)
{
  m_cooldownMs = std::max<int64_t>(ms, 0);
}

int64_t EdgeRules::cooldownMs() const
{
  return m_cooldownMs;
}

void EdgeRules::setArrivalGuardMs(int64_t ms)
{
  m_arrivalGuardMs = std::max<int64_t>(ms, 0);
}

int64_t EdgeRules::arrivalGuardMs() const
{
  return m_arrivalGuardMs;
}

void EdgeRules::onCrossed(Direction dir)
{
  m_lastCross = now();
  m_arrivalEdge = opposite(dir);
}

void EdgeRules::reset()
{
  m_lastCross.reset();
  m_arrivalEdge = Direction::NoDirection;
}

std::optional<EdgeRules::NoCrossReason> EdgeRules::checkTiming(Direction push, int64_t *remainingMs) const
{
  if (!m_lastCross.has_value()) {
    return std::nullopt;
  }

  const int64_t elapsed = now() - *m_lastCross;
  if (m_arrivalEdge != Direction::NoDirection && push == m_arrivalEdge && elapsed < m_arrivalGuardMs) {
    return NoCrossReason::ArrivalGuard;
  }
  if (elapsed < m_cooldownMs) {
    if (remainingMs != nullptr) {
      *remainingMs = m_cooldownMs - elapsed;
    }
    return NoCrossReason::Cooldown;
  }
  return std::nullopt;
}

std::optional<EdgeRules::NoCrossReason>
EdgeRules::check(const PushState &state, Direction push, int64_t *remainingMs) const
{
  if (!state.sharingOn) {
    return NoCrossReason::SharingOff;
  }
  if (state.locked) {
    return NoCrossReason::Locked;
  }
  if (state.buttonHeld) {
    return NoCrossReason::ButtonHeld;
  }
  return checkTiming(push, remainingMs);
}

bool EdgeRules::allowNoCrossLog()
{
  const int64_t t = now();
  if (m_lastNoCrossLog.has_value() && t - *m_lastNoCrossLog < kLogIntervalMs) {
    return false;
  }
  m_lastNoCrossLog = t;
  return true;
}

int64_t EdgeRules::now() const
{
  return m_clock();
}

} // namespace deskflow::server
