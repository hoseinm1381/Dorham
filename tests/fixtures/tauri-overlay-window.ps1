param([int]$DorhamPid, [ValidateSet('inspect','lock','unlock')][string]$Action)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class OverlayWindowProbe {
    delegate bool Visitor(IntPtr window, IntPtr context);
    [DllImport("user32.dll")] static extern bool EnumWindows(Visitor visitor, IntPtr context);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int capacity);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr window, int index);
    [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr code, IntPtr parameter, uint flags, uint timeout, out UIntPtr result);

    public static IntPtr[] Find(uint owner, string prefix) {
        var windows = new List<IntPtr>();
        EnumWindows((window, _) => {
            uint pid;
            GetWindowThreadProcessId(window, out pid);
            if (pid != owner) return true;
            var title = new StringBuilder(256);
            GetWindowText(window, title, title.Capacity);
            if (title.ToString().StartsWith(prefix, StringComparison.Ordinal)) windows.Add(window);
            return true;
        }, IntPtr.Zero);
        return windows.ToArray();
    }
}
'@

if ($Action -eq 'inspect') {
    $overlays = @([OverlayWindowProbe]::Find($DorhamPid, 'Dorham voice'))
    $first = if ($overlays.Count -eq 1) { $overlays[0] } else { [IntPtr]::Zero }
    $style = if ($first -ne [IntPtr]::Zero) { [OverlayWindowProbe]::GetWindowLong($first, -20) } else { 0 }
    @{
        count = $overlays.Count
        visible = $first -ne [IntPtr]::Zero -and [OverlayWindowProbe]::IsWindowVisible($first)
        focused = $first -ne [IntPtr]::Zero -and [OverlayWindowProbe]::GetForegroundWindow() -eq $first
        noActivate = ($style -band 0x08000000) -ne 0
        clickThrough = ($style -band 0x80020) -eq 0x80020
    } | ConvertTo-Json -Compress
    exit 0
}

$main = @([OverlayWindowProbe]::Find($DorhamPid, 'Dorham') | Where-Object {
    $_ -notin [OverlayWindowProbe]::Find($DorhamPid, 'Dorham voice') -and [OverlayWindowProbe]::IsWindowVisible($_)
})
if ($main.Count -ne 1) { throw 'Could not identify the owned Dorham main window.' }
$code = if ($Action -eq 'lock') { 7 } else { 8 }
$result = [UIntPtr]::Zero
if ([OverlayWindowProbe]::SendMessageTimeout($main[0], 0x02B1, [UIntPtr]::new([uint32]$code), [IntPtr]::Zero, 2, 1500, [ref]$result) -eq [IntPtr]::Zero) {
    throw 'The owned main window did not handle the Windows session message.'
}
