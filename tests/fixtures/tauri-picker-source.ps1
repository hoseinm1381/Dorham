param([int]$ProcessId, [ValidateSet('minimize','inspect')][string]$Action)

$ErrorActionPreference = 'Stop'
$process = Get-Process -Id $ProcessId
if ($process.MainWindowTitle -cne 'Dorham owned capture fixture selected' -or !$process.MainWindowHandle) {
  throw 'Expected the owned capture fixture window'
}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PickerFixtureWindow {
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int show);
}
'@
if ($Action -eq 'minimize' -and ![PickerFixtureWindow]::ShowWindowAsync($process.MainWindowHandle, 7)) {
  throw 'Could not minimize the owned capture fixture window'
}
if ($Action -eq 'minimize') {
  $deadline = [DateTime]::UtcNow.AddSeconds(2)
  while (![PickerFixtureWindow]::IsIconic($process.MainWindowHandle) -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 25
  }
}
@{minimized = [PickerFixtureWindow]::IsIconic($process.MainWindowHandle)} | ConvertTo-Json -Compress
