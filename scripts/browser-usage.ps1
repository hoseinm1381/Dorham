param([int]$RootPid=0)
$all = Get-CimInstance Win32_Process
$owned = [System.Collections.Generic.HashSet[int]]::new()
if ($RootPid -gt 0) { [void]$owned.Add($RootPid) }
for ($i=0; $i -lt 8; $i++) { foreach ($p in $all) { if ($owned.Contains([int]$p.ParentProcessId)) { [void]$owned.Add([int]$p.ProcessId) } } }
$totalChrome=0L
$ownChrome=0L
$ownBrowserIds=@()
foreach ($p in $all) {
    if ($p.Name -eq 'chrome.exe' -or $p.Name -eq 'msedge.exe' -or ($p.Name -eq 'Dorham.exe' -and $owned.Contains([int]$p.ProcessId))) {
        $live=Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
        if ($live) { $totalChrome += $live.WorkingSet64; if ($owned.Contains([int]$p.ProcessId)) { $ownChrome += $live.WorkingSet64; $ownBrowserIds += [int]$p.ProcessId } }
    }
}
[pscustomobject]@{ totalMiB=[math]::Round($totalChrome/1MB,1); ownedMiB=[math]::Round($ownChrome/1MB,1); ownedBrowserIds=$ownBrowserIds } | ConvertTo-Json -Compress
