# SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
# SPDX-License-Identifier: GPL-2.0-only
#
# Runs as SYSTEM from the scheduled task \OmniDesk\VirtualDisplay, started by
# OmniDesk (`schtasks /Run`). install-vdd.ps1 copies it to the admin-only
# %ProgramData%\OmniDesk\vdd\bin. It reads request\request.json (user-written,
# so every field is validated), writes driver\vdd_settings.xml with exactly one
# mode, turns the VDD device on (or restarts it) or off, and answers in
# status\status.json (only SYSTEM/Admins can write there).
#
# request.json: {"nonce":"<16-64 hex>","action":"on"|"off","width":1920,"height":1080,"refresh":60}

$ErrorActionPreference = 'Stop'
$Root = Join-Path $env:ProgramData 'OmniDesk\vdd'
$ReqFile = Join-Path $Root 'request\request.json'
$StatusFile = Join-Path $Root 'status\status.json'
$Settings = Join-Path $Root 'driver\vdd_settings.xml'
$HwId = 'Root\MttVDD'
Add-Type -Path (Join-Path $PSScriptRoot 'vdd-devices.cs') # SetupAPI lookup + state, copied here by install-vdd.ps1

function Set-Vdd([string]$id, [bool]$on) {
  $verb = if ($on) { '/enable-device' } else { '/disable-device' }
  $out = & pnputil.exe $verb "$id" 2>&1
  if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 3010) { throw "pnputil $verb failed ($LASTEXITCODE): $($out -join ' ')" }
}

function Answer($nonce, [bool]$ok, $err, $state) {
  $o = [ordered]@{ nonce = $nonce; ok = $ok; error = $err; state = $state; at = (Get-Date -Format o) }
  $tmp = "$StatusFile.tmp"
  [IO.File]::WriteAllText($tmp, ($o | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))
  Move-Item -Force $tmp $StatusFile
}

$nonce = ''
try {
  $item = Get-Item -LiteralPath $ReqFile -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'request is a link' }
  if ($item.Length -gt 4096) { throw 'request too large' }
  $req = [IO.File]::ReadAllText($ReqFile) | ConvertFrom-Json
  $nonce = [string]$req.nonce
  if ($nonce -notmatch '^[0-9a-f]{16,64}$') { $nonce = ''; throw 'bad nonce' }
  $action = [string]$req.action
  if ($action -ne 'on' -and $action -ne 'off') { throw 'bad action' }

  # The device install-vdd.ps1 recorded, else the first one SetupAPI finds.
  $ids = @([OmniVdd]::Find(@($HwId, 'MttVDD')))
  $id = $null
  try { $id = [string](Get-Content -Raw (Join-Path $Root 'installed.json') | ConvertFrom-Json).instanceId } catch { }
  if (-not $id -or $ids -notcontains $id) { $id = if ($ids.Count) { $ids[0] } else { $null } }
  if (-not $id) { throw 'driver-missing' }

  if ($action -eq 'off') {
    if ([OmniVdd]::State($id) -eq 'started') { Set-Vdd $id $false }
    Answer $nonce $true $null 'off'
    exit 0
  }

  $w = [int]$req.width; $h = [int]$req.height; $r = [int]$req.refresh
  if ($w -lt 640 -or $w -gt 7680 -or $h -lt 480 -or $h -gt 4320 -or $r -lt 24 -or $r -gt 240) { throw 'bad mode' }

  # One mode only, so Windows has to use it.
  $xml = @"
<?xml version='1.0' encoding='utf-8'?>
<vdd_settings>
  <monitors><count>1</count></monitors>
  <gpu><friendlyname>default</friendlyname></gpu>
  <global><g_refresh_rate>$r</g_refresh_rate></global>
  <resolutions>
    <resolution><width>$w</width><height>$h</height><refresh_rate>$r</refresh_rate></resolution>
  </resolutions>
  <options>
    <CustomEdid>false</CustomEdid><PreventSpoof>false</PreventSpoof><EdidCeaOverride>false</EdidCeaOverride>
    <HardwareCursor>true</HardwareCursor><SDR10bit>false</SDR10bit><HDRPlus>false</HDRPlus>
    <logging>false</logging><debuglogging>false</debuglogging>
  </options>
</vdd_settings>
"@
  [IO.File]::WriteAllText($Settings, $xml, (New-Object Text.UTF8Encoding $false))

  # The driver reads its settings when the device starts: restart it if it is on.
  if ([OmniVdd]::State($id) -eq 'started') {
    Set-Vdd $id $false
    Start-Sleep -Milliseconds 500
  }
  Set-Vdd $id $true
  $deadline = (Get-Date).AddSeconds(10)
  do {
    Start-Sleep -Milliseconds 250
    $st = [OmniVdd]::State($id)
  } while ($st -ne 'started' -and (Get-Date) -lt $deadline)
  if ($st -ne 'started') { throw "device status $st" }
  Answer $nonce $true $null 'on'
  exit 0
} catch {
  try { Answer $nonce $false ([string]$_.Exception.Message) 'error' } catch { }
  exit 1
}
