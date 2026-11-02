// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
//
// SetupAPI / CfgMgr32 helpers for the Virtual Display Driver device, loaded with Add-Type by
// install-vdd.ps1 (elevated) and vdd-task.ps1 (SYSTEM). Get-PnpDevice was not reliable for
// this: on a real PC it returned nothing right after the device was created, so every install
// created another monitor. These calls are the same API the device is created with.

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class OmniVdd {
  [StructLayout(LayoutKind.Sequential)]
  struct SP_DEVINFO_DATA { public int cbSize; public Guid ClassGuid; public int DevInst; public IntPtr Reserved; }

  [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool SetupDiGetINFClassW(string infName, out Guid classGuid, StringBuilder className, int classNameSize, out int requiredSize);
  [DllImport("setupapi.dll", SetLastError = true)]
  static extern IntPtr SetupDiCreateDeviceInfoList(ref Guid classGuid, IntPtr hwndParent);
  [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr SetupDiGetClassDevsW(IntPtr classGuid, string enumerator, IntPtr hwndParent, int flags);
  [DllImport("setupapi.dll", SetLastError = true)]
  static extern bool SetupDiEnumDeviceInfo(IntPtr set, int index, ref SP_DEVINFO_DATA data);
  [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool SetupDiCreateDeviceInfoW(IntPtr set, string deviceName, ref Guid classGuid, string description, IntPtr hwnd, int flags, ref SP_DEVINFO_DATA data);
  [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool SetupDiSetDeviceRegistryPropertyW(IntPtr set, ref SP_DEVINFO_DATA data, int property, byte[] buffer, int size);
  [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool SetupDiGetDeviceRegistryPropertyW(IntPtr set, ref SP_DEVINFO_DATA data, int property, out int regType, byte[] buffer, int size, out int required);
  [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool SetupDiGetDeviceInstanceIdW(IntPtr set, ref SP_DEVINFO_DATA data, StringBuilder id, int size, out int required);
  [DllImport("setupapi.dll", SetLastError = true)]
  static extern bool SetupDiCallClassInstaller(int installFunction, IntPtr set, ref SP_DEVINFO_DATA data);
  [DllImport("setupapi.dll", SetLastError = true)]
  static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);
  [DllImport("newdev.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool UpdateDriverForPlugAndPlayDevicesW(IntPtr hwnd, string hardwareId, string infPath, int flags, out bool reboot);
  [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)]
  static extern int CM_Locate_DevNodeW(out int devInst, string deviceId, int flags);
  [DllImport("cfgmgr32.dll")]
  static extern int CM_Get_DevNode_Status(out int status, out int problem, int devInst, int flags);

  const int DICD_GENERATE_ID = 1, SPDRP_HARDWAREID = 1, DIF_REGISTERDEVICE = 0x19, INSTALLFLAG_FORCE = 1;
  const int DIGCF_ALLCLASSES = 4; // no DIGCF_PRESENT: also devices that are not running
  const int CM_LOCATE_DEVNODE_PHANTOM = 1, CR_SUCCESS = 0, DN_STARTED = 0x8, DN_HAS_PROBLEM = 0x400, CM_PROB_DISABLED = 22;
  static readonly IntPtr Invalid = new IntPtr(-1);

  static string InstanceId(IntPtr set, ref SP_DEVINFO_DATA d) {
    var sb = new StringBuilder(512); int req;
    return SetupDiGetDeviceInstanceIdW(set, ref d, sb, sb.Capacity, out req) ? sb.ToString() : null;
  }

  // Same steps as `devcon install <inf> <hwid>`. Returns the new instance id; *reboot tells
  // whether Windows needs a restart.
  public static string CreateRootDevice(string inf, string hwid, out bool reboot) {
    Guid cls; var name = new StringBuilder(256); int req; string id;
    if (!SetupDiGetINFClassW(inf, out cls, name, name.Capacity, out req)) throw new Win32Exception();
    IntPtr set = SetupDiCreateDeviceInfoList(ref cls, IntPtr.Zero);
    if (set == Invalid) throw new Win32Exception();
    try {
      var d = new SP_DEVINFO_DATA(); d.cbSize = Marshal.SizeOf(typeof(SP_DEVINFO_DATA));
      if (!SetupDiCreateDeviceInfoW(set, name.ToString(), ref cls, null, IntPtr.Zero, DICD_GENERATE_ID, ref d)) throw new Win32Exception();
      byte[] ids = Encoding.Unicode.GetBytes(hwid + "\0\0");
      if (!SetupDiSetDeviceRegistryPropertyW(set, ref d, SPDRP_HARDWAREID, ids, ids.Length)) throw new Win32Exception();
      if (!SetupDiCallClassInstaller(DIF_REGISTERDEVICE, set, ref d)) throw new Win32Exception();
      id = InstanceId(set, ref d);
    } finally { SetupDiDestroyDeviceInfoList(set); }
    if (!UpdateDriverForPlugAndPlayDevicesW(IntPtr.Zero, hwid, inf, INSTALLFLAG_FORCE, out reboot)) throw new Win32Exception();
    return id;
  }

  // Instance ids of every device (running or not) with one of these hardware ids.
  public static string[] Find(string[] hwids) {
    var found = new List<string>();
    IntPtr set = SetupDiGetClassDevsW(IntPtr.Zero, null, IntPtr.Zero, DIGCF_ALLCLASSES);
    if (set == Invalid) throw new Win32Exception();
    try {
      var d = new SP_DEVINFO_DATA(); d.cbSize = Marshal.SizeOf(typeof(SP_DEVINFO_DATA));
      var buf = new byte[4096];
      for (int i = 0; SetupDiEnumDeviceInfo(set, i, ref d); i++) {
        int type, req;
        if (!SetupDiGetDeviceRegistryPropertyW(set, ref d, SPDRP_HARDWAREID, out type, buf, buf.Length, out req)) continue;
        foreach (var h in Encoding.Unicode.GetString(buf, 0, req).Split('\0')) {
          bool match = false;
          foreach (var want in hwids) if (string.Equals(h, want, StringComparison.OrdinalIgnoreCase)) match = true;
          if (!match) continue;
          var id = InstanceId(set, ref d);
          if (id != null) found.Add(id);
          break;
        }
      }
    } finally { SetupDiDestroyDeviceInfoList(set); }
    return found.ToArray();
  }

  // "started", "disabled", "stopped" (present, not running) or "absent" (not plugged in).
  public static string State(string instanceId) {
    int dev, status, problem;
    if (CM_Locate_DevNodeW(out dev, instanceId, CM_LOCATE_DEVNODE_PHANTOM) != CR_SUCCESS) return "absent";
    if (CM_Get_DevNode_Status(out status, out problem, dev, 0) != CR_SUCCESS) return "absent";
    if ((status & DN_HAS_PROBLEM) != 0 && problem == CM_PROB_DISABLED) return "disabled";
    return (status & DN_STARTED) != 0 ? "started" : "stopped";
  }
}
