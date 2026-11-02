/*
 * Deskflow -- mouse and keyboard sharing utility
 * SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
 * SPDX-License-Identifier: GPL-2.0-only WITH LicenseRef-OpenSSL-Exception
 */

#include "ServerConfigReadTests.h"

#include "common/Settings.h"
#include "server/Config.h"

#include <QSettings>

#include <sstream>
#include <string>

using deskflow::server::Config;

namespace {

// buildServerConfig() output for the owner's desk (PC 2560x1440 + 1920x1080, MacBook
// to the right of monitor 2), cooldown 300, arrival guard 120, lock hotkey Ctrl+Alt+L
const char *const kAppConfig = "# Written by OmniDesk. Edits are replaced when the layout changes.\n"
                               "section: screens\n"
                               "\tDESKTOP-PC:\n"
                               "\tMacBook-Pro:\n"
                               "end\n"
                               "\n"
                               "section: links\n"
                               "\tDESKTOP-PC:\n"
                               "\t\tright(16,84) = MacBook-Pro\n"
                               "\tMacBook-Pro:\n"
                               "\t\tleft = DESKTOP-PC(16,84)\n"
                               "end\n"
                               "\n"
                               "section: options\n"
                               "\tomnideskCrossCooldown = 300\n"
                               "\tomnideskArrivalGuard = 120\n"
                               "\tclipboardSharing = true\n"
                               "\tkeystroke(Control+Alt+l) = lockCursorToScreen(toggle)\n"
                               "end\n";

Config read(const std::string &text)
{
  Config config(nullptr);
  std::istringstream in(text);
  in >> config;
  return config;
}

std::string write(const Config &config)
{
  std::ostringstream out;
  out << config;
  return out.str();
}

int globalOption(const Config &config, OptionID id)
{
  const auto *options = config.getOptions("");
  if (options == nullptr) {
    return -1;
  }
  const auto i = options->find(id);
  return i == options->end() ? -1 : i->second;
}

} // namespace

void ServerConfigReadTests::initTestCase()
{
  QVERIFY(m_dir.isValid());
  const auto file = m_dir.filePath(QStringLiteral("Deskflow.conf"));
  {
    // what the app writes into Deskflow.conf (DO-NOT-RENAME §3)
    QSettings ini(file, QSettings::IniFormat);
    ini.setValue(QStringLiteral("computer_DESKTOP-PC/name"), QStringLiteral("DESKTOP-PC"));
    ini.setValue(QStringLiteral("computer_MacBook-Pro/name"), QStringLiteral("MacBook-Pro"));
    ini.setValue(QStringLiteral("server/omnideskCrossCooldown"), 400);
    ini.setValue(QStringLiteral("server/omnideskArrivalGuard"), 90);
    ini.sync();
  }
  Settings::setSettingsFile(file);
}

void ServerConfigReadTests::appConfig_roundTrip()
{
  const Config config = read(kAppConfig);

  QVERIFY(config.isComputer("DESKTOP-PC"));
  QVERIFY(config.isComputer("MacBook-Pro"));
  QVERIFY(config.hasNeighbor("DESKTOP-PC", Direction::Right));
  QVERIFY(!config.hasNeighbor("DESKTOP-PC", Direction::Left));
  // right(16,84): only that stretch of the PC's right side leads to the MacBook
  QCOMPARE(config.getNeighbor("DESKTOP-PC", Direction::Right, 0.5f, nullptr), std::string("MacBook-Pro"));
  QVERIFY(config.getNeighbor("DESKTOP-PC", Direction::Right, 0.1f, nullptr).empty());
  QCOMPARE(config.getNeighbor("MacBook-Pro", Direction::Left, 0.5f, nullptr), std::string("DESKTOP-PC"));

  // the config lines win over Deskflow.conf (400/90)
  QCOMPARE(globalOption(config, kOptionOmniDeskCrossCooldown), 300);
  QCOMPARE(globalOption(config, kOptionOmniDeskArrivalGuard), 120);

  // the lock hotkey is kept
  const auto text = write(config);
  QVERIFY2(
      text.find("keystroke(Control+Alt+L) = lockCursorToScreen(toggle)") != std::string::npos ||
          text.find("keystroke(Control+Alt+l) = lockCursorToScreen(toggle)") != std::string::npos,
      text.c_str()
  );

  // and writing it out and reading it again gives the same config
  const Config again = read(text);
  QVERIFY(again == config);
  QCOMPARE(globalOption(again, kOptionOmniDeskCrossCooldown), 300);
  QCOMPARE(globalOption(again, kOptionOmniDeskArrivalGuard), 120);
}

void ServerConfigReadTests::appConfig_settingsDefaultsWhenNoOptionLines()
{
  // without the option lines the Deskflow.conf values apply
  std::string text = kAppConfig;
  for (const char *line : {"\tomnideskCrossCooldown = 300\n", "\tomnideskArrivalGuard = 120\n"}) {
    text.erase(text.find(line), std::string(line).size());
  }
  const Config config = read(text);
  QCOMPARE(globalOption(config, kOptionOmniDeskCrossCooldown), 400);
  QCOMPARE(globalOption(config, kOptionOmniDeskArrivalGuard), 90);
}

void ServerConfigReadTests::mouseButtonHotkey_survivesReadBack()
{
  // upstream only parsed option lines starting with `keystroke` or `mousepress`, but the
  // condition (and what operator<< writes) is `mousebutton(...)`: those hotkeys vanished
  std::string text = kAppConfig;
  const std::string hotkey = "\tmousebutton(Control+2) = switchInDirection(right)\n";
  text.insert(text.rfind("end\n"), hotkey);

  const Config config = read(text);
  const auto written = write(config);
  QVERIFY2(written.find("mousebutton(Control+") != std::string::npos, written.c_str());
  QVERIFY2(written.find("switchInDirection(right)") != std::string::npos, written.c_str());

  const Config again = read(written);
  QVERIFY(again == config);
  QVERIFY(write(again).find("mousebutton(") != std::string::npos);
}

QTEST_MAIN(ServerConfigReadTests)
