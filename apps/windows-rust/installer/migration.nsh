!macro customInit
  # Official Microsoft detection locations. Restore electron-builder's 64-bit
  # registry view before looking up the stable Dorham uninstall/install records.
  ReadRegStr $R0 HKCU "Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" pv
  ${If} $R0 == ""
  ${OrIf} $R0 == "0.0.0.0"
    SetRegView 32
    ReadRegStr $R0 HKLM "Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" pv
    SetRegView 64
  ${EndIf}
  ${If} $R0 == ""
  ${OrIf} $R0 == "0.0.0.0"
    InitPluginsDir
    File /oname=$PLUGINSDIR\MicrosoftEdgeWebview2Setup.exe "$%DORHAM_WEBVIEW_BOOTSTRAPPER%"
    ExecWait '"$PLUGINSDIR\MicrosoftEdgeWebview2Setup.exe" /silent /install' $R1
    ${If} $R1 != 0
    ${AndIf} $R1 != 3010
      MessageBox MB_OK|MB_ICONSTOP "Microsoft WebView2 could not be installed. Your previous Dorham installation is unchanged. Please check your connection and retry."
      Abort
    ${EndIf}
  ${EndIf}
!macroend

# The vendored installSection invokes this AFTER CHECK_APP_RUNNING and BEFORE
# the old uninstaller executes. A failed export aborts without removing old app.
!macro customBeforeUninstall
  ${If} ${FileExists} "$INSTDIR\resources\app.asar"
    InitPluginsDir
    SetOutPath $PLUGINSDIR
    File "${BUILD_RESOURCES_DIR}\migrate-electron.ps1"
    File "${BUILD_RESOURCES_DIR}\export-electron.cjs"
    File "${BUILD_RESOURCES_DIR}\protect-export.ps1"
    nsExec::ExecToStack /TIMEOUT=120000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\migrate-electron.ps1" -InstallDir "$INSTDIR" -ProfileDir "$APPDATA\@dorhamdesktop" -MigrationDir "$LOCALAPPDATA\Dorham\migration"'
    Pop $R0
    Pop $R1
    ${If} $R0 != 0
      MessageBox MB_OK|MB_ICONSTOP "Your previous Dorham profile was preserved, but it could not be migrated. Installation stopped before removing the old app. Close Dorham and retry."
      Abort
    ${EndIf}
  ${EndIf}
!macroend
