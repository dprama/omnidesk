/*
 * Deskflow -- mouse and keyboard sharing utility
 * SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
 * SPDX-License-Identifier: GPL-2.0-only WITH LicenseRef-OpenSSL-Exception
 */

#pragma once

#include "base/DirectionTypes.h"
#include "base/MonitorRect.h"
#include "base/OmniDeskLog.h"

#include <cstdint>
#include <functional>
#include <optional>
#include <vector>

namespace deskflow::server {

/**
 * @brief Where a cursor position touches the monitor edges
 *
 * At most one horizontal and one vertical edge (a corner touches both).
 * x/y is the position clamped onto the monitor it belongs to.
 */
struct EdgeHit
{
  Direction horizontal = Direction::NoDirection;
  bool horizontalOuter = false;
  Direction vertical = Direction::NoDirection;
  bool verticalOuter = false;
  int32_t x = 0;
  int32_t y = 0;

  bool any() const
  {
    return horizontal != Direction::NoDirection || vertical != Direction::NoDirection;
  }
};

//! Result of moving the cursor of a client computer across its monitors
struct MoveStep
{
  //! true if the move pushes past an outer edge (in direction \p dir)
  bool leaves = false;
  Direction dir = Direction::NoDirection;
  //! where the cursor is now: the new point, or the point clamped onto its monitor
  int32_t x = 0;
  int32_t y = 0;
};

//! State of the server when the cursor pushes against an outer edge
struct PushState
{
  bool sharingOn = true;  //!< mouse sharing on (app `mouseSharing=on|off`)
  bool locked = false;    //!< cursor locked to the computer (scroll lock, hotkey, app)
  bool buttonHeld = false; //!< any mouse button down on the server's mouse
};

/**
 * @brief OmniDesk edge-crossing rules, free of any platform or display code
 *
 * - Outer edge: a push only counts at a monitor edge that no other monitor of the
 *   same computer continues (checked at the cursor's x or y, not on the bounding box).
 * - Cooldown: no crossing for cooldownMs() after a crossing.
 * - Arrival guard: for arrivalGuardMs() after a crossing, pushes against the edge the
 *   cursor arrived through are ignored.
 * - Rate limit: at most one `no-cross` log line every kLogIntervalMs.
 *
 * Time comes from an injectable clock (milliseconds, monotonic) so tests can drive it.
 */
class EdgeRules
{
public:
  using Clock = std::function<int64_t()>;
  using NoCrossReason = omnidesk::log::NoCrossReason;

  static constexpr int64_t kDefaultCooldownMs = 250;
  static constexpr int64_t kDefaultArrivalGuardMs = 150;
  static constexpr int64_t kLogIntervalMs = 2000;

  //! \p clock defaults to std::chrono::steady_clock
  explicit EdgeRules(Clock clock = {});

  //! Which monitor edges \p x, \p y is within \p zoneSize pixels of, and whether each is outer
  static EdgeHit classify(const std::vector<MonitorRect> &monitors, int32_t x, int32_t y, int32_t zoneSize);

  /**
   * @brief Like classify(), for a cursor that moved from \p fromX, \p fromY
   *
   * A point on no monitor (Windows low-level hooks report the unclipped position the
   * cursor was pushed to) belongs to the monitor the cursor came from, not to whichever
   * monitor happens to be nearest: pushing up out of a monitor next to a taller one
   * must be a push against the top edge it left, not against the taller one's side.
   */
  static EdgeHit classify(
      const std::vector<MonitorRect> &monitors, int32_t x, int32_t y, int32_t zoneSize, int32_t fromX, int32_t fromY
  );

  //! True if no other monitor continues past the \p dir edge of the monitor holding \p x, \p y
  static bool isOuterEdge(const std::vector<MonitorRect> &monitors, Direction dir, int32_t x, int32_t y);

  /**
   * @brief Move a cursor from \p oldX, \p oldY to \p newX, \p newY over \p monitors
   *
   * If the new point is on a monitor the cursor just goes there. Otherwise it is
   * clamped onto the monitor it came from; if it went past an outer edge of that
   * monitor (horizontal edges first) the step `leaves` in that direction.
   */
  static MoveStep
  moveOnMonitors(const std::vector<MonitorRect> &monitors, int32_t oldX, int32_t oldY, int32_t newX, int32_t newY);

  static Direction opposite(Direction dir);

  //! Smallest rectangle holding every monitor (all zero if there are none)
  static MonitorRect boundingBox(const std::vector<MonitorRect> &monitors);

  void setCooldownMs(int64_t ms);
  int64_t cooldownMs() const;
  void setArrivalGuardMs(int64_t ms);
  int64_t arrivalGuardMs() const;

  //! Record a crossing made while moving in \p dir; starts the cooldown and the arrival guard
  void onCrossed(Direction dir);

  //! Forget the last crossing
  void reset();

  /**
   * @brief Timing rules for a push in direction \p push
   * @return ArrivalGuard, Cooldown (with \p remainingMs set) or nothing if a crossing may happen
   */
  std::optional<NoCrossReason> checkTiming(Direction push, int64_t *remainingMs = nullptr) const;

  /**
   * @brief All non-geometric rules for a push in direction \p push, in this order:
   * sharing-off, locked, button-held, arrival-guard, cooldown
   * @return the first rule that blocks the crossing, or nothing
   */
  std::optional<NoCrossReason> check(const PushState &state, Direction push, int64_t *remainingMs = nullptr) const;

  //! True (and starts a new interval) if a `no-cross` line may be logged now
  bool allowNoCrossLog();

  int64_t now() const;

private:
  Clock m_clock;
  int64_t m_cooldownMs = kDefaultCooldownMs;
  int64_t m_arrivalGuardMs = kDefaultArrivalGuardMs;
  std::optional<int64_t> m_lastCross;
  Direction m_arrivalEdge = Direction::NoDirection;
  std::optional<int64_t> m_lastNoCrossLog;
};

} // namespace deskflow::server
