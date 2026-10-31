param([int]$RootPid=0)
$ErrorActionPreference = 'Stop'
# Some managed Windows sessions deny CIM. Always measure total browser memory
# with Get-Process; parent information improves attribution but is not required
# to enforce the combined budget. Never report a false zero on a CIM failure.
$processTreeAvailable = $true
try { $all = Get-CimInstance Win32_Process -ErrorAction Stop }
catch { $all = @(); $processTreeAvailable = $false }
$owned = [System.Collections.Generic.HashSet[int]]::new()
if ($RootPid -gt 0) { [void]$owned.Add($RootPid) }
for ($i=0; $i -lt 8; $i++) { foreach ($p in $all) { if ($owned.Contains([int]$p.ParentProcessId)) { [void]$owned.Add([int]$p.ProcessId) } } }
$totalChrome=0L
$ownChrome=0L
$ownCpu=0.0
$ownBrowserIds=@()
foreach ($live in (Get-Process | Where-Object { $_.ProcessName -in @('chrome', 'msedge', 'Dorham') })) {
    if ($live) {
        $totalChrome += $live.WorkingSet64
        if ($owned.Contains([int]$live.Id)) { $ownChrome += $live.WorkingSet64; $ownCpu += $live.CPU; $ownBrowserIds += [int]$live.Id }
    }
}
[pscustomobject]@{ at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); processTreeAvailable=$processTreeAvailable; ownedCpuSeconds=$ownCpu; logicalProcessors=[Environment]::ProcessorCount; totalMiB=[math]::Round($totalChrome/1MB,1); ownedMiB=[math]::Round($ownChrome/1MB,1); ownedBrowserIds=$ownBrowserIds } | ConvertTo-Json -Compress
