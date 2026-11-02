# SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
# SPDX-License-Identifier: GPL-2.0-only
#
# Installs or removes the Virtual Display Driver (VDD, MIT, SignPath-signed)
# for OmniDesk's "use a laptop as a second screen". The NSIS installer runs it
# ELEVATED, once:
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-vdd.ps1 -Action install   -DriverDir "<res>\vdd\VirtualDisplayDriver" -TaskScript "<res>\vdd\vdd-task.ps1"
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-vdd.ps1 -Action uninstall
#
# What install does (no devcon needed):
#   1. pnputil /add-driver MttVDD.inf (the driver store keeps the signed package).
#   2. Creates the root-enumerated device Root\MttVDD with SetupAPI (what
#      `devcon install` does) unless one already exists, then disables it so no
#      monitor shows until OmniDesk asks for one.
#   3. %ProgramData%\OmniDesk\vdd\
#        bin\vdd-task.ps1      admin-only; the only code that runs as SYSTEM
#        driver\vdd_settings.xml  admin-only; HKLM\SOFTWARE\MikeTheTech\VirtualDisplayDriver\VDDPATH points here
#        request\              users may write request.json here; the task validates it
#        status\               admin-only write; the task's answer (status.json) for the app
#        installed.json        marker read by the app
#   4. Scheduled task \OmniDesk\VirtualDisplay (runs vdd-task.ps1 as SYSTEM, on demand
#      only). Its security descriptor lets Authenticated Users run it, so the app
#      can turn the monitor on and off without a UAC prompt each time.
#
# Exit codes: 0 ok, 3010 ok but reboot needed, 1 error.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('install', 'uninstall')][string]$Action,
  [string]$DriverDir,
  [string]$TaskScript
)

$ErrorActionPreference = 'Stop'
$HwId = 'Root\MttVDD'
$Root = Join-Path $env:ProgramData 'OmniDesk\vdd'
$TaskFolder = '\OmniDesk'
$TaskName = 'VirtualDisplay'
$RegKey = 'HKLM:\SOFTWARE\MikeTheTech\VirtualDisplayDriver'
$LogFile = Join-Path $env:ProgramData 'OmniDesk\vdd-install.log'

function Log($m) {
  $line = "$(Get-Date -Format s) $m"
  Write-Host $line
  try { New-Item -ItemType Directory -Force -Path (Split-Path $LogFile) | Out-Null; Add-Content -Path $LogFile -Value $line } catch { }
}

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Log 'error: must run elevated'; exit 1
}

Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class OmniVddSetup {
  [StructLayout(LayoutKind.Sequential)]
  struct SP_DEVINFO_DATA { public int cbSize; public Guid ClassGuid; public int DevInst; public IntPtr Reserved; }

  [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool SetupDiGetINFClassW(string infName, out Guid classGuid, StringBuilder className, int classNameSize, out int requiredSize);
  [DllImport("setupapi.dll", SetLastError = true)]
  static extern IntPtr SetupDiCreateDeviceInfoList(ref Guid classGuid, IntPtr hwndParent);
  [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool SetupDiCreateDeviceInfoW(IntPtr set, string deviceName, ref Guid classGuid, string description, IntPtr hwnd, int flags, ref SP_DEVINFO_DATA data);
  [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool SetupDiSetDeviceRegistryPropertyW(IntPtr set, ref SP_DEVINFO_DATA data, int property, byte[] buffer, int size);
  [DllImport("setupapi.dll", SetLastError = true)]
  static extern bool SetupDiCallClassInstaller(int installFunction, IntPtr set, ref SP_DEVINFO_DATA data);
  [DllImport("setupapi.dll", SetLastError = true)]
  static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);
  [DllImport("newdev.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool UpdateDriverForPlugAndPlayDevicesW(IntPtr hwnd, string hardwareId, string infPath, int flags, out bool reboot);

  const int DICD_GENERATE_ID = 1, SPDRP_HARDWAREID = 1, DIF_REGISTERDEVICE = 0x19, INSTALLFLAG_FORCE = 1;

  // Same steps as `devcon install <inf> <hwid>`. Returns true if a reboot is needed.
  public static bool CreateRootDevice(string inf, string hwid) {
    Guid cls; var name = new StringBuilder(256); int req;
    if (!SetupDiGetINFClassW(inf, out cls, name, name.Capacity, out req)) throw new Win32Exception();
    IntPtr set = SetupDiCreateDeviceInfoList(ref cls, IntPtr.Zero);
    if (set == new IntPtr(-1)) throw new Win32Exception();
    try {
      var d = new SP_DEVINFO_DATA(); d.cbSize = Marshal.SizeOf(typeof(SP_DEVINFO_DATA));
      if (!SetupDiCreateDeviceInfoW(set, name.ToString(), ref cls, null, IntPtr.Zero, DICD_GENERATE_ID, ref d)) throw new Win32Exception();
      byte[] ids = Encoding.Unicode.GetBytes(hwid + "\0\0");
      if (!SetupDiSetDeviceRegistryPropertyW(set, ref d, SPDRP_HARDWAREID, ids, ids.Length)) throw new Win32Exception();
      if (!SetupDiCallClassInstaller(DIF_REGISTERDEVICE, set, ref d)) throw new Win32Exception();
    } finally { SetupDiDestroyDeviceInfoList(set); }
    bool reboot;
    if (!UpdateDriverForPlugAndPlayDevicesW(IntPtr.Zero, hwid, inf, INSTALLFLAG_FORCE, out reboot)) throw new Win32Exception();
    return reboot;
  }
}
'@

function Get-VddDevices {
  @(Get-PnpDevice -PresentOnly:$false -ErrorAction SilentlyContinue | Where-Object {
      $_.HardwareID -and ($_.HardwareID -contains $HwId -or $_.HardwareID -contains 'MttVDD')
    })
}

# Folder ACL: SYSTEM + Administrators full; Users read (or modify for request\).
function Set-Acl-Strict($path, [bool]$usersWrite) {
  New-Item -ItemType Directory -Force -Path $path | Out-Null
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
  $none = [System.Security.AccessControl.PropagationFlags]::None
  foreach ($sid in 'S-1-5-18', 'S-1-5-32-544') {
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier $sid), 'FullControl', $inherit, $none, 'Allow')))
  }
  $right = if ($usersWrite) { 'Modify' } else { 'ReadAndExecute' }
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-32-545'), $right, $inherit, $none, 'Allow')))
  # The UMDF host runs as LOCAL SERVICE and must read vdd_settings.xml.
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-19'), 'Modify', $inherit, $none, 'Allow')))
  Set-Acl -Path $path -AclObject $acl
}

function Register-VddTask($scriptPath) {
  $svc = New-Object -ComObject 'Schedule.Service'
  $svc.Connect()
  $rootFolder = $svc.GetFolder('\')
  try { $folder = $svc.GetFolder($TaskFolder) } catch { $folder = $rootFolder.CreateFolder($TaskFolder.TrimStart('\')) }
  $def = $svc.NewTask(0)
  $def.RegistrationInfo.Description = 'OmniDesk: turns its virtual monitor on or off on request. Runs only when OmniDesk asks.'
  $def.Settings.Enabled = $true
  $def.Settings.AllowDemandStart = $true
  $def.Settings.StartWhenAvailable = $false
  $def.Settings.DisallowStartIfOnBatteries = $false
  $def.Settings.StopIfGoingOnBatteries = $false
  $def.Settings.ExecutionTimeLimit = 'PT2M'
  $def.Settings.MultipleInstances = 2   # TASK_INSTANCES_QUEUE
  $def.Principal.RunLevel = 1           # highest
  $act = $def.Actions.Create(0)         # exec
  $act.Path = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $act.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`""
  # SYSTEM/Admins full, Authenticated Users read+execute (= may run it).
  $sddl = 'D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;AU)'
  # 6 = TASK_CREATE_OR_UPDATE, 5 = TASK_LOGON_SERVICE_ACCOUNT
  $folder.RegisterTaskDefinition($TaskName, $def, 6, 'SYSTEM', $null, 5, $sddl) | Out-Null
}

function Unregister-VddTask {
  try {
    $svc = New-Object -ComObject 'Schedule.Service'; $svc.Connect()
    $folder = $svc.GetFolder($TaskFolder)
    try { $folder.DeleteTask($TaskName, 0) } catch { }
    try { $svc.GetFolder('\').DeleteFolder($TaskFolder.TrimStart('\'), 0) } catch { }
  } catch { }
}

function Write-DefaultSettings($dir) {
  $xml = @'
<?xml version='1.0' encoding='utf-8'?>
<vdd_settings>
  <monitors><count>1</count></monitors>
  <gpu><friendlyname>default</friendlyname></gpu>
  <global><g_refresh_rate>60</g_refresh_rate></global>
  <resolutions>
    <resolution><width>1920</width><height>1080</height><refresh_rate>60</refresh_rate></resolution>
  </resolutions>
  <options>
    <CustomEdid>false</CustomEdid><PreventSpoof>false</PreventSpoof><EdidCeaOverride>false</EdidCeaOverride>
    <HardwareCursor>true</HardwareCursor><SDR10bit>false</SDR10bit><HDRPlus>false</HDRPlus>
    <logging>false</logging><debuglogging>false</debuglogging>
  </options>
</vdd_settings>
'@
  [IO.File]::WriteAllText((Join-Path $dir 'vdd_settings.xml'), $xml, (New-Object Text.UTF8Encoding $false))
}

try {
  if ($Action -eq 'install') {
    if (-not $DriverDir -or -not (Test-Path (Join-Path $DriverDir 'MttVDD.inf'))) { throw "MttVDD.inf not found in '$DriverDir'" }
    if (-not $TaskScript -or -not (Test-Path $TaskScript)) { throw "vdd-task.ps1 not found at '$TaskScript'" }
    $inf = (Resolve-Path (Join-Path $DriverDir 'MttVDD.inf')).Path
    # Same pins as native/windows-vdd/fetch.mjs (checked at build time too): never
    # hand pnputil a driver package that differs from the reviewed release.
    $Pinned = @{
      'MttVDD.dll' = 'c9ca837f57a98fbd43bc416a7f535a95843626e7759eaf85cf0cd7ce334dbb05'
      'MttVDD.inf' = '550d211fe481e74dfe3f9d724ed78be48b3a9113405965d683d9373e8d672f5d'
      'mttvdd.cat' = '08a0093fc9b2e32b287a6f8a77ca4de0a31830d29fc33d2b13a918dc859468f6'
    }
    foreach ($f in $Pinned.Keys) {
      $got = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $DriverDir $f)).Hash.ToLowerInvariant()
      if ($got -ne $Pinned[$f]) { throw "SHA-256 mismatch for $f (got $got)" }
    }
    Log 'driver files match the pinned SHA-256'

    Set-Acl-Strict $Root $false
    Set-Acl-Strict (Join-Path $Root 'bin') $false
    Set-Acl-Strict (Join-Path $Root 'driver') $false
    Set-Acl-Strict (Join-Path $Root 'request') $true
    Set-Acl-Strict (Join-Path $Root 'status') $false
    Copy-Item -Force $TaskScript (Join-Path $Root 'bin\vdd-task.ps1')
    Write-DefaultSettings (Join-Path $Root 'driver')

    New-Item -Force -Path $RegKey | Out-Null
    $hadPath = (Get-ItemProperty -Path $RegKey -Name VDDPATH -ErrorAction SilentlyContinue)
    Set-ItemProperty -Path $RegKey -Name VDDPATH -Value (Join-Path $Root 'driver')

    Log "pnputil /add-driver $inf"
    & pnputil.exe /add-driver "$inf" | ForEach-Object { Log "  $_" }

    $reboot = $false
    $existing = Get-VddDevices
    $weCreated = $false
    if ($existing.Count -eq 0) {
      Log "creating device $HwId"
      $reboot = [OmniVddSetup]::CreateRootDevice($inf, $HwId)
      $weCreated = $true
      Start-Sleep -Seconds 2
    } else {
      Log "device already present: $($existing[0].InstanceId)"
    }
    $dev = (Get-VddDevices)[0]
    if (-not $dev) { throw 'device was not created' }
    # Off until OmniDesk asks for a monitor.
    try { Disable-PnpDevice -InstanceId $dev.InstanceId -Confirm:$false } catch { Log "disable failed: $($_.Exception.Message)" }

    Register-VddTask (Join-Path $Root 'bin\vdd-task.ps1')

    $marker = @{ version = '25.7.23'; instanceId = $dev.InstanceId; weCreated = $weCreated; oldVddPath = $(if ($hadPath) { [string]$hadPath.VDDPATH } else { '' }); installedAt = (Get-Date -Format o) } | ConvertTo-Json
    [IO.File]::WriteAllText((Join-Path $Root 'installed.json'), $marker, (New-Object Text.UTF8Encoding $false))
    Log "installed (instance $($dev.InstanceId))"
    if ($reboot) { exit 3010 } else { exit 0 }
  }

  # ---- uninstall ----
  $marker = $null
  try { $marker = Get-Content -Raw (Join-Path $Root 'installed.json') | ConvertFrom-Json } catch { }
  Unregister-VddTask
  if ($marker -and $marker.weCreated) {
    foreach ($d in Get-VddDevices) {
      Log "removing device $($d.InstanceId)"
      & pnputil.exe /remove-device "$($d.InstanceId)" | ForEach-Object { Log "  $_" }
    }
    $pkgs = @()
    try { $pkgs = @(Get-WindowsDriver -Online | Where-Object { $_.OriginalFileName -like '*\mttvdd.inf' } | ForEach-Object { $_.Driver }) } catch { }
    foreach ($p in $pkgs) {
      Log "pnputil /delete-driver $p /uninstall /force"
      & pnputil.exe /delete-driver "$p" /uninstall /force | ForEach-Object { Log "  $_" }
    }
  }
  if ($marker) {
    if ($marker.oldVddPath) { Set-ItemProperty -Path $RegKey -Name VDDPATH -Value $marker.oldVddPath }
    else { Remove-ItemProperty -Path $RegKey -Name VDDPATH -ErrorAction SilentlyContinue }
  }
  if ($marker -and -not $marker.weCreated) {
    # Someone else installed VDD before us: leave the driver, just switch the monitor back on.
    foreach ($d in Get-VddDevices) { try { Enable-PnpDevice -InstanceId $d.InstanceId -Confirm:$false } catch { } }
  }
  Remove-Item -Recurse -Force $Root -ErrorAction SilentlyContinue
  Log 'uninstalled'
  exit 0
} catch {
  Log "error: $($_.Exception.Message)"
  exit 1
}
