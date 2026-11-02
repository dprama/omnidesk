/*
 * Deskflow -- mouse and keyboard sharing utility
 * SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
 * SPDX-License-Identifier: GPL-2.0-only WITH LicenseRef-OpenSSL-Exception
 */

#include <QTest>

class EdgeRulesTests : public QObject
{
  Q_OBJECT
private Q_SLOTS:
  void outerEdge_ownerLayout();
  void outerEdge_topAndBottom();
  void classify_innerEdge();
  void classify_outerEdgeOffBoundingBox();
  void classify_pointOutsideMonitors();
  void classify_singleMonitorCorner();
  void classify_offMonitorUsesMonitorItCameFrom();
  void classify_negativeCoordinates();
  void boundingBox_ofMonitors();
  void format_matchesAppPatterns();
  void cooldown_blocksThenAllows();
  void cooldown_zeroDisables();
  void arrivalGuard_onlyArrivalEdge();
  void check_buttonHeld();
  void check_order();
  void rateLimiter_twoSeconds();
  void format_noCross();
  void format_noCrossCooldown();
  void format_cross();
  void format_start();
  void clientMove_ownerLayout_innerEdgePasses();
  void clientMove_ownerLayout_outerEdges();
  void clientMove_ownerLayout_gapClamps();
  void clientMove_boundingBoxFallback();
  void parseMonitors_roundTrip();
  void parseMonitors_invalid();
  void utf8Prefix_keepsWholeCharacters();
};
