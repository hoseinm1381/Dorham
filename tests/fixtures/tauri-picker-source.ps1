param([int]$ProcessId, [long]$WindowHandle, [ValidateSet('minimize','inspect')][string]$Action)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class PickerFixtureWindow {
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int show);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, StringBuilder text, int capacity);
}
'@
$window = [IntPtr]::new($WindowHandle)
$owner = [uint32]0
$title = [Text.StringBuilder]::new(120)
[void][PickerFixtureWindow]::GetWindowThreadProcessId($window, [ref]$owner)
[void][PickerFixtureWindow]::GetWindowText($window, $title, $title.Capacity)
if ($owner -ne $ProcessId -or $title.ToString() -cne 'Dorham owned capture fixture selected') {
  throw 'Expected the owned capture fixture window'
}
if ($Action -eq 'minimize' -and ![PickerFixtureWindow]::ShowWindowAsync($window, 7)) {
  throw 'Could not minimize the owned capture fixture window'
}
if ($Action -eq 'minimize') {
  $deadline = [DateTime]::UtcNow.AddSeconds(2)
  while (![PickerFixtureWindow]::IsIconic($window) -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 25
  }
}
@{minimized = [PickerFixtureWindow]::IsIconic($window)} | ConvertTo-Json -Compress
