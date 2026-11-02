# SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
# SPDX-License-Identifier: GPL-2.0-only
# Collects the Windows engine binaries the app needs into one flat folder:
#   deskflow-core.exe, deskflow-daemon.exe, Qt DLLs + plugins (windeployqt),
#   OpenSSL 3 DLLs (vcpkg), and the app-local MSVC runtime DLLs.
# Run from a shell where the MSVC environment is set (VCToolsRedistDir) and Qt's bin is on PATH.
#
#   pwsh build/engine/deploy-windows.ps1 -BuildDir build-engine -OutDir engine-dist/win-x64 -Arch x64 -Triplet x64-windows-release

param(
  [Parameter(Mandatory)] [string] $BuildDir,
  [Parameter(Mandatory)] [string] $OutDir,
  [Parameter(Mandatory)] [ValidateSet('x64', 'arm64')] [string] $Arch,
  [Parameter(Mandatory)] [string] $Triplet
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$bin = Join-Path $BuildDir 'bin'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path

foreach ($exe in 'deskflow-core.exe', 'deskflow-daemon.exe') {
  $src = Join-Path $bin $exe
  if (-not (Test-Path $src)) { throw "missing $src" }
  Copy-Item $src $OutDir -Force
}

# Qt runtime (Core, Gui, Widgets, Network + platforms/qwindows, styles, tls backends).
# --no-compiler-runtime: we ship the CRT DLLs ourselves below (windeployqt would only add vc_redist.exe).
$wdq = (Get-Command windeployqt -ErrorAction Stop).Source
foreach ($exe in 'deskflow-core.exe', 'deskflow-daemon.exe') {
  & $wdq --release --no-translations --no-system-d3d-compiler --no-opengl-sw `
    --no-compiler-runtime --no-quick-import --dir $OutDir (Join-Path $OutDir $exe)
  if ($LASTEXITCODE -ne 0) { throw "windeployqt failed for $exe" }
}

# OpenSSL 3 from vcpkg (classic mode via johnwason/vcpkg-action, or manifest mode in the build dir).
$ws = if ($env:GITHUB_WORKSPACE) { $env:GITHUB_WORKSPACE } else { (Get-Location).Path }
$sslDirs = @(@(
  (Join-Path $BuildDir "vcpkg_installed/$Triplet/bin"),
  (Join-Path $ws "vcpkg/installed/$Triplet/bin"),
  $(if ($env:VCPKG_ROOT) { Join-Path $env:VCPKG_ROOT "installed/$Triplet/bin" })
) | Where-Object { $_ -and (Test-Path $_) })
$ssl = @()
foreach ($d in $sslDirs) {
  $ssl = @(Get-ChildItem $d -Filter 'lib*-3*.dll' | Where-Object { $_.Name -match '^lib(ssl|crypto)-3' })
  if ($ssl.Count -ge 2) { break }
}
if ($ssl.Count -lt 2) {
  $ssl = @(Get-ChildItem $ws -Recurse -Filter 'lib*-3*.dll' -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^lib(ssl|crypto)-3' -and $_.FullName -match [regex]::Escape("installed\$Triplet\bin") })
}
if ($ssl.Count -lt 2) { throw "OpenSSL DLLs for $Triplet not found (searched: $($sslDirs -join ', '))" }
$ssl | ForEach-Object { Copy-Item $_.FullName $OutDir -Force; Write-Host "openssl: $($_.FullName)" }

# App-local MSVC runtime (the engine checks the CRT version it was built with).
if (-not $env:VCToolsRedistDir) { throw 'VCToolsRedistDir not set: run inside the MSVC dev environment' }
$crt = Get-ChildItem (Join-Path $env:VCToolsRedistDir $Arch) -Directory -Filter 'Microsoft.VC*.CRT' |
  Sort-Object Name -Descending | Select-Object -First 1
if (-not $crt) { throw "no CRT redist folder under $($env:VCToolsRedistDir)\$Arch" }
Get-ChildItem $crt.FullName -Filter '*.dll' | ForEach-Object { Copy-Item $_.FullName $OutDir -Force }
Write-Host "crt: $($crt.FullName)"

# Drop things the app never needs.
Get-ChildItem $OutDir -Recurse -Include '*.pdb', '*.ilk', '*.lib', '*.exp' | Remove-Item -Force

# Every non-system DLL the two executables import must now sit next to them.
$dumpbin = (Get-Command dumpbin -ErrorAction SilentlyContinue).Source
if ($dumpbin) {
  $missing = @()
  $queue = [System.Collections.Generic.Queue[string]]::new()
  $seen = @{}
  'deskflow-core.exe', 'deskflow-daemon.exe' | ForEach-Object { $queue.Enqueue((Join-Path $OutDir $_)) }
  while ($queue.Count) {
    $f = $queue.Dequeue()
    $deps = & $dumpbin /nologo /dependents $f | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '\.dll$' }
    foreach ($d in $deps) {
      if ($seen.ContainsKey($d.ToLower())) { continue }
      $seen[$d.ToLower()] = $true
      $local = Join-Path $OutDir $d
      if (Test-Path $local) { $queue.Enqueue($local); continue }
      if ($d -match '^(api-ms-|ext-ms-)' -or (Test-Path (Join-Path "$env:SystemRoot\System32" $d))) { continue }
      $missing += "$d (needed by $(Split-Path $f -Leaf))"
    }
  }
  if ($missing) { throw "unresolved DLLs:`n$($missing -join "`n")" }
}

Get-ChildItem $OutDir -Recurse -File | Select-Object @{n = 'path'; e = { $_.FullName.Substring($OutDir.Length + 1) } }, Length | Format-Table -AutoSize
