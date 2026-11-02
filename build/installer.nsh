; SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
; SPDX-License-Identifier: GPL-2.0-only
;
; Included by electron-builder's NSIS installer (nsis.include in
; app/electron-builder.config.js). The installer is per-machine (elevated), so
; these steps run as administrator:
;   - Windows Firewall inbound allow rules, scoped to the local subnet and,
;     where possible, to the program that listens:
;       TCP 24800  engine (deskflow-core.exe)
;       TCP 24802  pairing           (OmniDesk.exe)
;       TCP 24803  peer channel      (OmniDesk.exe)
;       UDP 5353   mDNS discovery    (OmniDesk.exe)
;   - Virtual Display Driver for "use a laptop as a second screen"
;     (resources\vdd\install-vdd.ps1, x64 Windows only). Exit 3010 = restart needed.
; Uninstall removes the rules and the driver (not on an in-place update).

!include LogicLib.nsh
!include x64.nsh

!define OD_FW_ENGINE "OmniDesk engine (TCP 24800)"
!define OD_FW_PAIR   "OmniDesk pairing (TCP 24802)"
!define OD_FW_PEER   "OmniDesk peer channel (TCP 24803)"
!define OD_FW_MDNS   "OmniDesk discovery (UDP 5353)"
; WebRTC (second screen, camera) uses random UDP ports, so this rule is scoped to the program.
!define OD_FW_MEDIA  "OmniDesk screen and camera (UDP)"

; 64-bit system tools even though the installer itself is 32-bit.
!macro odSysTool OUT NAME
  StrCpy ${OUT} "$WINDIR\SysNative\${NAME}"
  IfFileExists "${OUT}" +2 0
  StrCpy ${OUT} "$SYSDIR\${NAME}"
!macroend

!macro odFwRule NETSH NAME PROTO PORT PROGRAM
  nsExec::ExecToLog '"${NETSH}" advfirewall firewall delete rule name="${NAME}"'
  Pop $0
  nsExec::ExecToLog '"${NETSH}" advfirewall firewall add rule name="${NAME}" dir=in action=allow enable=yes profile=any protocol=${PROTO} localport=${PORT} remoteip=localsubnet program="${PROGRAM}"'
  Pop $0
  ${If} $0 != 0
    DetailPrint "Could not add the firewall rule ${NAME} (exit $0)."
  ${EndIf}
!macroend

!macro odFwDelete NETSH NAME
  nsExec::ExecToLog '"${NETSH}" advfirewall firewall delete rule name="${NAME}"'
  Pop $0
!macroend

!macro customInstall
  !insertmacro odSysTool $R8 "netsh.exe"
  DetailPrint "Allowing OmniDesk through Windows Firewall (local network only)"
  !insertmacro odFwRule $R8 "${OD_FW_ENGINE}" TCP 24800 "$INSTDIR\resources\engine\deskflow-core.exe"
  !insertmacro odFwRule $R8 "${OD_FW_PAIR}" TCP 24802 "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  !insertmacro odFwRule $R8 "${OD_FW_PEER}" TCP 24803 "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  !insertmacro odFwRule $R8 "${OD_FW_MDNS}" UDP 5353 "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  !insertmacro odFwRule $R8 "${OD_FW_MEDIA}" UDP any "$INSTDIR\${APP_EXECUTABLE_FILENAME}"

  ${If} ${IsNativeAMD64}
  ${AndIf} ${FileExists} "$INSTDIR\resources\vdd\install-vdd.ps1"
    !insertmacro odSysTool $R9 "WindowsPowerShell\v1.0\powershell.exe"
    DetailPrint "Installing the virtual display driver (second screen)"
    nsExec::ExecToLog '"$R9" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\vdd\install-vdd.ps1" -Action install -DriverDir "$INSTDIR\resources\vdd\VirtualDisplayDriver" -TaskScript "$INSTDIR\resources\vdd\vdd-task.ps1"'
    Pop $0
    ${If} $0 == 3010
      MessageBox MB_OK|MB_ICONINFORMATION "OmniDesk is installed. Restart Windows before you use a laptop as a second screen. Everything else works now." /SD IDOK
    ${ElseIf} $0 != 0
      DetailPrint "Virtual display driver setup failed (exit $0). See %ProgramData%\OmniDesk\vdd-install.log"
      MessageBox MB_OK|MB_ICONEXCLAMATION "OmniDesk is installed, but the virtual display driver could not be set up, so this PC can't use a laptop as a second screen yet. Everything else works. You can run the installer again later to retry." /SD IDOK
    ${EndIf}
  ${EndIf}
!macroend

!macro customUnInstall
  ${IfNot} ${isUpdated}
    !insertmacro odSysTool $R8 "netsh.exe"
    !insertmacro odFwDelete $R8 "${OD_FW_ENGINE}"
    !insertmacro odFwDelete $R8 "${OD_FW_PAIR}"
    !insertmacro odFwDelete $R8 "${OD_FW_PEER}"
    !insertmacro odFwDelete $R8 "${OD_FW_MDNS}"
    !insertmacro odFwDelete $R8 "${OD_FW_MEDIA}"
    ${If} ${FileExists} "$INSTDIR\resources\vdd\install-vdd.ps1"
      !insertmacro odSysTool $R9 "WindowsPowerShell\v1.0\powershell.exe"
      DetailPrint "Removing the virtual display driver"
      nsExec::ExecToLog '"$R9" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\vdd\install-vdd.ps1" -Action uninstall'
      Pop $0
      ${If} $0 == 3010
        MessageBox MB_OK|MB_ICONINFORMATION "OmniDesk is removed. Restart Windows to finish removing the virtual display driver." /SD IDOK
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend
