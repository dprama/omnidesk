/*
 * Deskflow -- mouse and keyboard sharing utility
 * SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
 * SPDX-License-Identifier: GPL-2.0-only WITH LicenseRef-OpenSSL-Exception
 */

#include "EdgeRulesTests.h"

#include "base/OmniDeskLog.h"
#include "server/EdgeRules.h"

#include <QRegularExpression>

#include <memory>
#include <optional>
#include <string>
#include <vector>

using deskflow::server::EdgeHit;
using deskflow::server::EdgeRules;
using deskflow::server::PushState;
using omnidesk::log::NoCrossReason;

namespace {

// the owner's layout: 1440p on the left, 1080p on the right, 180 px lower
const std::vector<MonitorRect> kOwnerLayout = {{0, 0, 2560, 1440}, {2560, 180, 1920, 1080}};

struct FakeClock
{
  std::shared_ptr<int64_t> now = std::make_shared<int64_t>(1000);

  EdgeRules::Clock clock() const
  {
    return [n = now] { return *n; };
  }

  void advance(int64_t ms) const
  {
    *now += ms;
  }
};

} // namespace

void EdgeRulesTests::outerEdge_ownerLayout()
{
  using enum Direction;
  // monitor 2 continues to the right of monitor 1 for y in [180,1260)
  QVERIFY(!EdgeRules::isOuterEdge(kOwnerLayout, Right, 2559, 180));
  QVERIFY(!EdgeRules::isOuterEdge(kOwnerLayout, Right, 2559, 812));
  QVERIFY(!EdgeRules::isOuterEdge(kOwnerLayout, Right, 2559, 1259));
  // ...but not above or below it
  for (int y = 0; y < 180; y += 20) {
    QVERIFY(EdgeRules::isOuterEdge(kOwnerLayout, Right, 2559, y));
  }
  QVERIFY(EdgeRules::isOuterEdge(kOwnerLayout, Right, 2559, 179));
  QVERIFY(EdgeRules::isOuterEdge(kOwnerLayout, Right, 2559, 1260));
  QVERIFY(EdgeRules::isOuterEdge(kOwnerLayout, Right, 2559, 1439));
  // far right of monitor 2
  QVERIFY(EdgeRules::isOuterEdge(kOwnerLayout, Right, 4479, 640));
  QVERIFY(EdgeRules::isOuterEdge(kOwnerLayout, Right, 4479, 180));
  // left of monitor 2 is monitor 1
  QVERIFY(!EdgeRules::isOuterEdge(kOwnerLayout, Left, 2560, 640));
  // left of monitor 1
  QVERIFY(EdgeRules::isOuterEdge(kOwnerLayout, Left, 0, 640));
}

void EdgeRulesTests::outerEdge_topAndBottom()
{
  using enum Direction;
  QVERIFY(EdgeRules::isOuterEdge(kOwnerLayout, Top, 1000, 0));
  QVERIFY(EdgeRules::isOuterEdge(kOwnerLayout, Top, 3000, 180));
  QVERIFY(EdgeRules::isOuterEdge(kOwnerLayout, Bottom, 3000, 1259));
  QVERIFY(EdgeRules::isOuterEdge(kOwnerLayout, Bottom, 1000, 1439));

  // stacked: monitor 2 directly under monitor 1, offset to the right
  const std::vector<MonitorRect> stacked = {{0, 0, 1920, 1080}, {960, 1080, 1920, 1080}};
  QVERIFY(EdgeRules::isOuterEdge(stacked, Bottom, 500, 1079));
  QVERIFY(!EdgeRules::isOuterEdge(stacked, Bottom, 1500, 1079));
  QVERIFY(!EdgeRules::isOuterEdge(stacked, Top, 1500, 1080));
  QVERIFY(EdgeRules::isOuterEdge(stacked, Top, 2500, 1080));
}

void EdgeRulesTests::classify_innerEdge()
{
  const EdgeHit hit = EdgeRules::classify(kOwnerLayout, 2559, 812, 1);
  QCOMPARE(hit.horizontal, Direction::Right);
  QVERIFY(!hit.horizontalOuter);
  QCOMPARE(hit.vertical, Direction::NoDirection);
  QCOMPARE(hit.x, 2559);
  QCOMPARE(hit.y, 812);

  // the middle of a monitor touches nothing
  QVERIFY(!EdgeRules::classify(kOwnerLayout, 1280, 720, 1).any());
}

void EdgeRulesTests::classify_outerEdgeOffBoundingBox()
{
  // x=2559 above monitor 2: an outer edge although the bounding box goes on to 4479
  const EdgeHit hit = EdgeRules::classify(kOwnerLayout, 2559, 100, 1);
  QCOMPARE(hit.horizontal, Direction::Right);
  QVERIFY(hit.horizontalOuter);

  const EdgeHit far = EdgeRules::classify(kOwnerLayout, 4479, 640, 1);
  QCOMPARE(far.horizontal, Direction::Right);
  QVERIFY(far.horizontalOuter);
}

void EdgeRulesTests::classify_pointOutsideMonitors()
{
  // Windows low-level hooks can report a point just past the edge the cursor is pinned to
  const EdgeHit hit = EdgeRules::classify(kOwnerLayout, 2560, 100, 1);
  QCOMPARE(hit.horizontal, Direction::Right);
  QVERIFY(hit.horizontalOuter);
  QCOMPARE(hit.x, 2559);
  QCOMPARE(hit.y, 100);

  // just above monitor 2 at its right end: top and right, both outer
  const EdgeHit corner = EdgeRules::classify(kOwnerLayout, 4479, 179, 1);
  QCOMPARE(corner.horizontal, Direction::Right);
  QVERIFY(corner.horizontalOuter);
  QCOMPARE(corner.vertical, Direction::Top);
  QVERIFY(corner.verticalOuter);
  QCOMPARE(corner.y, 180);

  QVERIFY(!EdgeRules::classify({}, 10, 10, 1).any());
}

void EdgeRulesTests::classify_singleMonitorCorner()
{
  const std::vector<MonitorRect> single = {{0, 0, 1920, 1080}};
  const EdgeHit hit = EdgeRules::classify(single, 0, 1079, 1);
  QCOMPARE(hit.horizontal, Direction::Left);
  QVERIFY(hit.horizontalOuter);
  QCOMPARE(hit.vertical, Direction::Bottom);
  QVERIFY(hit.verticalOuter);
}

void EdgeRulesTests::classify_offMonitorUsesMonitorItCameFrom()
{
  using enum Direction;
  // A 1920x1080 at 0,0; B 2560x1440 to its right, 200 px higher (Windows coords)
  const std::vector<MonitorRect> layout = {{0, 0, 1920, 1080}, {1920, -200, 2560, 1440}};

  // pushing up out of A near the seam: the low-level hook reports (1915,-8), which is on
  // no monitor and nearer to B's left side than to A's top. It is a push against A's top
  // edge (outer: nothing above A), not against B's left side.
  const EdgeHit hit = EdgeRules::classify(layout, 1915, -8, 1, 1915, 0);
  QCOMPARE(hit.vertical, Top);
  QVERIFY(hit.verticalOuter);
  QCOMPARE(hit.x, 1915);
  QCOMPARE(hit.y, 0);
  QCOMPARE(hit.horizontal, NoDirection);

  // without the previous position the nearest monitor (B) would be picked
  const EdgeHit nearest = EdgeRules::classify(layout, 1915, -8, 1);
  QCOMPARE(nearest.horizontal, Left);
  QCOMPARE(nearest.vertical, NoDirection);

  // exactly in A's top-right corner pushing straight up: a tie in distance, still A's top
  const EdgeHit corner = EdgeRules::classify(layout, 1919, -1, 1, 1919, 0);
  QCOMPARE(corner.vertical, Top);
  QVERIFY(corner.verticalOuter);
  // its right edge is next to B there: inner, never a crossing
  QCOMPARE(corner.horizontal, Right);
  QVERIFY(!corner.horizontalOuter);

  // a point on a monitor is classified on that monitor whatever the previous position
  const EdgeHit onB = EdgeRules::classify(layout, 1920, -1, 1, 1919, 0);
  QCOMPARE(onB.horizontal, Left);
  QVERIFY(onB.horizontalOuter); // A starts at y=0, so nothing is left of B at y=-1
  QCOMPARE(onB.vertical, NoDirection);
}

void EdgeRulesTests::classify_negativeCoordinates()
{
  using enum Direction;
  // Windows: a monitor left of and above the primary
  const std::vector<MonitorRect> layout = {{-1920, -300, 1920, 1080}, {0, 0, 2560, 1440}};

  // the left monitor's right edge is inner where the primary continues (y >= 0) ...
  QVERIFY(!EdgeRules::isOuterEdge(layout, Right, -1, 100));
  // ... and outer above the primary
  QVERIFY(EdgeRules::isOuterEdge(layout, Right, -1, -100));
  // the primary's top edge is outer to the right of the left monitor, which never
  // reaches above y=0 at x>=0
  QVERIFY(EdgeRules::isOuterEdge(layout, Top, 10, 0));
  // left edge of the left monitor, bottom of the left monitor (y=779) partly over nothing
  const EdgeHit left = EdgeRules::classify(layout, -1920, -300, 1);
  QCOMPARE(left.horizontal, Left);
  QVERIFY(left.horizontalOuter);
  QCOMPARE(left.vertical, Top);
  QVERIFY(left.verticalOuter);
  const EdgeHit bottom = EdgeRules::classify(layout, -50, 779, 1);
  QCOMPARE(bottom.vertical, Bottom);
  QVERIFY(bottom.verticalOuter);
  // the primary's left edge at y=100 is next to the left monitor: inner
  const EdgeHit primaryLeft = EdgeRules::classify(layout, 0, 100, 1);
  QCOMPARE(primaryLeft.horizontal, Left);
  QVERIFY(!primaryLeft.horizontalOuter);
  // ... and below the left monitor it is outer
  QVERIFY(EdgeRules::isOuterEdge(layout, Left, 0, 900));
}

void EdgeRulesTests::boundingBox_ofMonitors()
{
  QCOMPARE(EdgeRules::boundingBox(kOwnerLayout), (MonitorRect{0, 0, 4480, 1440}));
  const std::vector<MonitorRect> negative = {{-1920, -300, 1920, 1080}, {0, 0, 2560, 1440}};
  QCOMPARE(EdgeRules::boundingBox(negative), (MonitorRect{-1920, -300, 4480, 1740}));
  QCOMPARE(EdgeRules::boundingBox({}), MonitorRect{});
}

void EdgeRulesTests::format_matchesAppPatterns()
{
  // the patterns app/main/engine/decisions.js parses (documented in base/OmniDeskLog.h)
  const QRegularExpression noCross(
      QStringLiteral("^no-cross reason=(not-outer-edge|outside-zone|button-held|cooldown|arrival-guard|locked|"
                     "sharing-off|no-neighbour) edge=(left|right|top|bottom) pos=\\((-?\\d+),(-?\\d+)\\) "
                     "monitors=((?:\\[-?\\d+,-?\\d+,\\d+x\\d+\\])+)(?: remaining=(\\d+)ms)?$")
  );
  const QRegularExpression cross(
      QStringLiteral("^cross edge=(left|right|top|bottom) pos=\\((-?\\d+),(-?\\d+)\\) to=(.+) cooldown=(\\d+)ms$")
  );
  QVERIFY(noCross.isValid());
  QVERIFY(cross.isValid());

  const std::vector<MonitorRect> negative = {{-1920, -300, 1920, 1080}, {0, 0, 2560, 1440}};
  using enum NoCrossReason;
  for (const auto reason :
       {NotOuterEdge, OutsideZone, ButtonHeld, Cooldown, ArrivalGuard, Locked, SharingOff, NoNeighbour}) {
    for (const auto dir : {Direction::Left, Direction::Right, Direction::Top, Direction::Bottom}) {
      const auto line = QString::fromStdString(omnidesk::log::formatNoCross(reason, dir, -1920, -300, negative, 75));
      const auto m = noCross.match(line);
      QVERIFY2(m.hasMatch(), qPrintable(line));
      QCOMPARE(m.captured(1), QString::fromLatin1(omnidesk::log::reasonName(reason)));
      QCOMPARE(m.captured(3), QStringLiteral("-1920"));
      QCOMPARE(m.captured(6).isEmpty(), reason != Cooldown);
    }
  }
  const auto line = QString::fromStdString(omnidesk::log::formatCross(Direction::Top, 10, -300, "Studio Mac", 250));
  const auto m = cross.match(line);
  QVERIFY2(m.hasMatch(), qPrintable(line));
  QCOMPARE(m.captured(4), QStringLiteral("Studio Mac"));
}

void EdgeRulesTests::cooldown_blocksThenAllows()
{
  FakeClock clock;
  EdgeRules rules(clock.clock());
  QCOMPARE(rules.cooldownMs(), int64_t{250});
  QVERIFY(!rules.checkTiming(Direction::Right).has_value());

  rules.onCrossed(Direction::Right);
  clock.advance(100);
  int64_t remaining = 0;
  QCOMPARE(rules.checkTiming(Direction::Right, &remaining), std::optional(NoCrossReason::Cooldown));
  QCOMPARE(remaining, int64_t{150});

  clock.advance(149);
  QCOMPARE(rules.checkTiming(Direction::Top, &remaining), std::optional(NoCrossReason::Cooldown));
  QCOMPARE(remaining, int64_t{1});

  clock.advance(1);
  QVERIFY(!rules.checkTiming(Direction::Right).has_value());
  QVERIFY(!rules.checkTiming(Direction::Left).has_value());
}

void EdgeRulesTests::cooldown_zeroDisables()
{
  FakeClock clock;
  EdgeRules rules(clock.clock());
  rules.setCooldownMs(0);
  rules.setArrivalGuardMs(0);
  rules.onCrossed(Direction::Right);
  QVERIFY(!rules.checkTiming(Direction::Right).has_value());
  QVERIFY(!rules.checkTiming(Direction::Left).has_value());

  rules.setCooldownMs(-5);
  QCOMPARE(rules.cooldownMs(), int64_t{0});
}

void EdgeRulesTests::arrivalGuard_onlyArrivalEdge()
{
  FakeClock clock;
  EdgeRules rules(clock.clock());
  rules.setCooldownMs(0); // look at the guard alone
  QCOMPARE(rules.arrivalGuardMs(), int64_t{150});

  // moving right onto the next computer: it arrived through that computer's left edge
  rules.onCrossed(Direction::Right);
  clock.advance(10);
  QCOMPARE(rules.checkTiming(Direction::Left), std::optional(NoCrossReason::ArrivalGuard));
  QVERIFY(!rules.checkTiming(Direction::Right).has_value());
  QVERIFY(!rules.checkTiming(Direction::Top).has_value());

  clock.advance(139);
  QCOMPARE(rules.checkTiming(Direction::Left), std::optional(NoCrossReason::ArrivalGuard));
  clock.advance(1);
  QVERIFY(!rules.checkTiming(Direction::Left).has_value());

  // with the default cooldown, the guard is reported for the arrival edge, the cooldown elsewhere
  rules.setCooldownMs(250);
  rules.onCrossed(Direction::Bottom);
  QCOMPARE(rules.checkTiming(Direction::Top), std::optional(NoCrossReason::ArrivalGuard));
  QCOMPARE(rules.checkTiming(Direction::Bottom), std::optional(NoCrossReason::Cooldown));
  clock.advance(200);
  QCOMPARE(rules.checkTiming(Direction::Top), std::optional(NoCrossReason::Cooldown));
}

void EdgeRulesTests::check_buttonHeld()
{
  FakeClock clock;
  EdgeRules rules(clock.clock());
  PushState state;
  QVERIFY(!rules.check(state, Direction::Right).has_value());

  state.buttonHeld = true;
  QCOMPARE(rules.check(state, Direction::Right), std::optional(NoCrossReason::ButtonHeld));
  QCOMPARE(rules.check(state, Direction::Left), std::optional(NoCrossReason::ButtonHeld));

  state.buttonHeld = false;
  QVERIFY(!rules.check(state, Direction::Right).has_value());
}

void EdgeRulesTests::check_order()
{
  FakeClock clock;
  EdgeRules rules(clock.clock());
  rules.onCrossed(Direction::Right);

  PushState state{false, true, true};
  QCOMPARE(rules.check(state, Direction::Left), std::optional(NoCrossReason::SharingOff));
  state.sharingOn = true;
  QCOMPARE(rules.check(state, Direction::Left), std::optional(NoCrossReason::Locked));
  state.locked = false;
  QCOMPARE(rules.check(state, Direction::Left), std::optional(NoCrossReason::ButtonHeld));
  state.buttonHeld = false;
  QCOMPARE(rules.check(state, Direction::Left), std::optional(NoCrossReason::ArrivalGuard));
  int64_t remaining = 0;
  QCOMPARE(rules.check(state, Direction::Right, &remaining), std::optional(NoCrossReason::Cooldown));
  QCOMPARE(remaining, int64_t{250});
}

void EdgeRulesTests::rateLimiter_twoSeconds()
{
  FakeClock clock;
  EdgeRules rules(clock.clock());
  QVERIFY(rules.allowNoCrossLog());
  QVERIFY(!rules.allowNoCrossLog());
  clock.advance(1999);
  QVERIFY(!rules.allowNoCrossLog());
  clock.advance(1);
  QVERIFY(rules.allowNoCrossLog());
  clock.advance(500);
  QVERIFY(!rules.allowNoCrossLog());
  clock.advance(1500);
  QVERIFY(rules.allowNoCrossLog());
}

void EdgeRulesTests::format_noCross()
{
  const auto line =
      omnidesk::log::formatNoCross(NoCrossReason::NotOuterEdge, Direction::Right, 2559, 812, kOwnerLayout);
  QCOMPARE(
      QString::fromStdString(line), QStringLiteral(
                                        "no-cross reason=not-outer-edge edge=right pos=(2559,812) "
                                        "monitors=[0,0,2560x1440][2560,180,1920x1080]"
                                    )
  );

  const std::vector<MonitorRect> negative = {{-1920, -200, 1920, 1080}};
  QCOMPARE(
      QString::fromStdString(
          omnidesk::log::formatNoCross(NoCrossReason::NoNeighbour, Direction::Top, -100, -200, negative)
      ),
      QStringLiteral("no-cross reason=no-neighbour edge=top pos=(-100,-200) monitors=[-1920,-200,1920x1080]")
  );

  QCOMPARE(omnidesk::log::reasonName(NoCrossReason::OutsideZone), "outside-zone");
  QCOMPARE(omnidesk::log::reasonName(NoCrossReason::ButtonHeld), "button-held");
  QCOMPARE(omnidesk::log::reasonName(NoCrossReason::ArrivalGuard), "arrival-guard");
  QCOMPARE(omnidesk::log::reasonName(NoCrossReason::Locked), "locked");
  QCOMPARE(omnidesk::log::reasonName(NoCrossReason::SharingOff), "sharing-off");
  QCOMPARE(omnidesk::log::edgeName(Direction::Left), "left");
  QCOMPARE(omnidesk::log::edgeName(Direction::Bottom), "bottom");
}

void EdgeRulesTests::format_noCrossCooldown()
{
  const std::vector<MonitorRect> single = {{0, 0, 1920, 1080}};
  QCOMPARE(
      QString::fromStdString(
          omnidesk::log::formatNoCross(NoCrossReason::Cooldown, Direction::Left, 0, 500, single, 120)
      ),
      QStringLiteral("no-cross reason=cooldown edge=left pos=(0,500) monitors=[0,0,1920x1080] remaining=120ms")
  );
  // remaining is only written for a cooldown
  QCOMPARE(
      QString::fromStdString(
          omnidesk::log::formatNoCross(NoCrossReason::ButtonHeld, Direction::Left, 0, 500, single, 120)
      ),
      QStringLiteral("no-cross reason=button-held edge=left pos=(0,500) monitors=[0,0,1920x1080]")
  );
}

void EdgeRulesTests::format_cross()
{
  QCOMPARE(
      QString::fromStdString(omnidesk::log::formatCross(Direction::Right, 4479, 640, "MacBook", 300)),
      QStringLiteral("cross edge=right pos=(4479,640) to=MacBook cooldown=300ms")
  );
}

void EdgeRulesTests::format_start()
{
  QCOMPARE(
      QString::fromStdString(omnidesk::log::formatStart(
          "server", "C:\\Program Files\\OmniDesk\\deskflow-core.exe", "1.25.0.0+2877600", 4242
      )),
      QStringLiteral("start mode=server helper=C:\\Program Files\\OmniDesk\\deskflow-core.exe "
                     "version=1.25.0.0+2877600 pid=4242")
  );
}

// the owner's PC as a CLIENT (a MacBook is the server): its monitors come from the
// app's `peerMonitors=` IPC, in the PC's own desktop coordinates

void EdgeRulesTests::clientMove_ownerLayout_innerEdgePasses()
{
  // from monitor 1 into monitor 2: no crossing, the cursor just moves on
  const auto step = EdgeRules::moveOnMonitors(kOwnerLayout, 2555, 800, 2565, 800);
  QVERIFY(!step.leaves);
  QCOMPARE(step.x, 2565);
  QCOMPARE(step.y, 800);

  // and back
  const auto back = EdgeRules::moveOnMonitors(kOwnerLayout, 2562, 800, 2550, 802);
  QVERIFY(!back.leaves);
  QCOMPARE(back.x, 2550);
}

void EdgeRulesTests::clientMove_ownerLayout_outerEdges()
{
  using enum Direction;
  // right of monitor 1 above monitor 2 (y < 180) is an outer edge
  const auto above = EdgeRules::moveOnMonitors(kOwnerLayout, 2558, 100, 2563, 100);
  QVERIFY(above.leaves);
  QCOMPARE(above.dir, Right);
  QCOMPARE(above.x, 2559);
  QCOMPARE(above.y, 100);

  // far right of monitor 2
  const auto far = EdgeRules::moveOnMonitors(kOwnerLayout, 4478, 640, 4485, 640);
  QVERIFY(far.leaves);
  QCOMPARE(far.dir, Right);
  QCOMPARE(far.x, 4479);

  // left of monitor 1
  const auto left = EdgeRules::moveOnMonitors(kOwnerLayout, 2, 640, -3, 640);
  QVERIFY(left.leaves);
  QCOMPARE(left.dir, Left);
  QCOMPARE(left.x, 0);

  // top of monitor 2 (y=180) and bottom of monitor 2 (y=1259) are outer
  const auto top = EdgeRules::moveOnMonitors(kOwnerLayout, 3000, 182, 3000, 175);
  QVERIFY(top.leaves);
  QCOMPARE(top.dir, Top);
  QCOMPARE(top.y, 180);
  const auto bottom = EdgeRules::moveOnMonitors(kOwnerLayout, 3000, 1257, 3000, 1262);
  QVERIFY(bottom.leaves);
  QCOMPARE(bottom.dir, Bottom);
  QCOMPARE(bottom.y, 1259);
}

void EdgeRulesTests::clientMove_ownerLayout_gapClamps()
{
  // diagonal from monitor 1 into the gap above monitor 2 (and past its own
  // right edge, which is outer there): leaves to the right
  const auto diagonal = EdgeRules::moveOnMonitors(kOwnerLayout, 2550, 185, 2570, 170);
  QVERIFY(diagonal.leaves);
  QCOMPARE(diagonal.dir, Direction::Right);

  // from monitor 2 up-left into the gap at x<2560 is on monitor 1: just moves
  const auto onto1 = EdgeRules::moveOnMonitors(kOwnerLayout, 2565, 185, 2555, 170);
  QVERIFY(!onto1.leaves);
  QCOMPARE(onto1.x, 2555);
  QCOMPARE(onto1.y, 170);

  // from monitor 2's top-left corner up-left: lands on monitor 1, no crossing
  const auto corner = EdgeRules::moveOnMonitors(kOwnerLayout, 2561, 181, 2559, 178);
  QVERIFY(!corner.leaves); // (2559,178) is on monitor 1
}

void EdgeRulesTests::clientMove_boundingBoxFallback()
{
  // without peer monitors the server uses the bounding box: x=2559 is not an edge
  const std::vector<MonitorRect> box = {{0, 0, 4480, 1440}};
  QVERIFY(!EdgeRules::moveOnMonitors(box, 2558, 100, 2563, 100).leaves);
  const auto right = EdgeRules::moveOnMonitors(box, 4478, 100, 4482, 100);
  QVERIFY(right.leaves);
  QCOMPARE(right.dir, Direction::Right);
  QCOMPARE(right.x, 4479);
}

void EdgeRulesTests::parseMonitors_roundTrip()
{
  const auto text = omnidesk::log::formatMonitors(kOwnerLayout);
  QCOMPARE(QString::fromStdString(text), QStringLiteral("[0,0,2560x1440][2560,180,1920x1080]"));
  const auto parsed = omnidesk::log::parseMonitors(text);
  QVERIFY(parsed.has_value());
  QVERIFY(*parsed == kOwnerLayout);

  const auto negative = omnidesk::log::parseMonitors("[-1920,-200,1920x1080]");
  QVERIFY(negative.has_value());
  QCOMPARE(negative->size(), size_t{1});
  QCOMPARE(negative->front().x, -1920);

  const auto empty = omnidesk::log::parseMonitors("");
  QVERIFY(empty.has_value());
  QVERIFY(empty->empty());
}

void EdgeRulesTests::parseMonitors_invalid()
{
  QVERIFY(!omnidesk::log::parseMonitors("[0,0,2560x1440").has_value());
  QVERIFY(!omnidesk::log::parseMonitors("[0,0,2560,1440]").has_value());
  QVERIFY(!omnidesk::log::parseMonitors("[0,0,0x1440]").has_value());
  QVERIFY(!omnidesk::log::parseMonitors("[a,0,10x10]").has_value());
  QVERIFY(!omnidesk::log::parseMonitors("0,0,10x10").has_value());
}

void EdgeRulesTests::utf8Prefix_keepsWholeCharacters()
{
  using omnidesk::log::utf8Prefix;
  QCOMPARE(utf8Prefix("hello", 3), std::string("hel"));
  QCOMPARE(utf8Prefix("hi", 200), std::string("hi"));
  // 199 ASCII characters and an emoji (4 UTF-8 bytes, a surrogate pair in UTF-16)
  const std::string emoji = "\xF0\x9F\x98\x80";
  const std::string text = std::string(199, 'a') + emoji + "tail";
  const auto cut = utf8Prefix(text, 200);
  QCOMPARE(cut, std::string(199, 'a') + emoji);
  const auto q = QString::fromStdString(cut);
  QVERIFY(!q.back().isHighSurrogate());
  QCOMPARE(q.size(), 201); // 199 + one surrogate pair
  // QString::left(200) would have split the pair
  QVERIFY(QString::fromStdString(text).left(200).back().isHighSurrogate());
  // multi-byte characters count once
  QCOMPARE(utf8Prefix("\xC3\xA9\xC3\xA9\xC3\xA9", 2), std::string("\xC3\xA9\xC3\xA9"));
}

QTEST_MAIN(EdgeRulesTests)
