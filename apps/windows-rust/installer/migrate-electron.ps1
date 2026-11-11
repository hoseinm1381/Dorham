param(
  [Parameter(Mandatory=$true)][string]$InstallDir,
  [Parameter(Mandatory=$true)][string]$ProfileDir,
  [Parameter(Mandatory=$true)][string]$MigrationDir,
  [string]$Validator
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1')
function Full([string]$value) { [IO.Path]::GetFullPath($value).TrimEnd('\') }
$install = Full $InstallDir
$profile = Full $ProfileDir
$migration = Full $MigrationDir
$oldApp = Join-Path $install 'resources\app.asar'
# First installs and subsequent Rust-to-Rust upgrades have no Electron profile
# exporter to run. Never replace an already-consumed Rust session with old data.
if (-not (Test-Path -LiteralPath $oldApp -PathType Leaf)) { exit 0 }
if (-not (Test-Path -LiteralPath $profile -PathType Container)) { exit 0 }
if ($migration.StartsWith($profile + '\', [StringComparison]::OrdinalIgnoreCase) -or $migration -eq $profile) { throw 'Migration output must stay outside the original profile.' }
$destination = Join-Path $migration 'electron-export-v1.json'
if (!$Validator -and (Test-Path -LiteralPath $destination)) { exit 0 }
$deadline = [DateTime]::UtcNow.AddSeconds(10)
do {
  $running = @(Get-Process -Name Dorham -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -and (Full $_.Path).StartsWith($install + '\', [StringComparison]::OrdinalIgnoreCase)
  })
  if (!$running.Count) { break }
  Start-Sleep -Milliseconds 200
} while ([DateTime]::UtcNow -lt $deadline)
if ($running.Count) { throw 'Close the previous Dorham application before migration.' }
New-Item -ItemType Directory -Path $migration -Force | Out-Null
# Private backup and export directories inherit no permissive parent ACEs.
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false)
$rights = [Security.AccessControl.FileSystemRights]::FullControl
$inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,$rights,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)))
[IO.Directory]::SetAccessControl($migration, $acl)
$work = Join-Path $migration ('backups\electron-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
$backup = Join-Path $work 'original-profile'
$profileWork = Join-Path $work 'profile-work'
$runtime = Join-Path $work 'export-runtime'
$pending = if ($Validator) { Join-Path $work 'verified-export.json' } else { $destination }
foreach ($root in @($profile,$install)) {
  if ((Get-Item -LiteralPath $root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Profile/runtime links require manual migration.' }
  foreach ($file in Get-ChildItem -LiteralPath $root -Force -Recurse) { if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Profile/runtime links require manual migration.' } }
}
Copy-Item -LiteralPath $profile -Destination $backup -Recurse -Force
$hashes = @{}
foreach ($file in Get-ChildItem -LiteralPath $profile -Recurse -File -Force) {
  $relative = $file.FullName.Substring($profile.Length + 1)
  $digest = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
  if ((Get-FileHash -LiteralPath (Join-Path $backup $relative) -Algorithm SHA256).Hash -ne $digest) { throw 'Original profile backup verification failed.' }
  $hashes[$relative] = $digest.ToLowerInvariant()
}
Copy-Item -LiteralPath $backup -Destination $profileWork -Recurse -Force
New-Item -ItemType Directory -Path $runtime | Out-Null
# Clone the old engine for a one-time export; no old product code executes.
# The clone is retained for local rollback, never bundled in the Rust release.
foreach ($entry in Get-ChildItem -LiteralPath $install -Force) {
  if ($entry.Name -eq 'resources' -or $entry.Name -like 'Uninstall*') { continue }
  Copy-Item -LiteralPath $entry.FullName -Destination (Join-Path $runtime $entry.Name) -Recurse -Force
}
$helper = Join-Path $runtime 'resources\app'
New-Item -ItemType Directory -Path $helper -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'export-electron.cjs') -Destination $helper
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'protect-export.ps1') -Destination $helper
[IO.File]::WriteAllText((Join-Path $helper 'package.json'), '{"name":"dorham-private-migration","version":"1.0.0","main":"export-electron.cjs"}', (New-Object Text.UTF8Encoding($false)))
$sourceVersion = (Get-Item -LiteralPath (Join-Path $install 'Dorham.exe')).VersionInfo.FileVersion
if ($sourceVersion -match '^(\d+\.\d+\.\d+)(?:\.0)?$') { $sourceVersion=$Matches[1] } else { throw 'Unrecognized previous application version.' }
$previousWork = $env:DORHAM_MIGRATION_WORK; $previousExport = $env:DORHAM_MIGRATION_EXPORT; $previousVersion = $env:DORHAM_MIGRATION_SOURCE_VERSION; $previousNode = $env:ELECTRON_RUN_AS_NODE
try {
  $env:DORHAM_MIGRATION_WORK=$work; $env:DORHAM_MIGRATION_EXPORT=$pending; $env:DORHAM_MIGRATION_SOURCE_VERSION=$sourceVersion
  $env:ELECTRON_RUN_AS_NODE=$null
  $process = Start-Process -FilePath (Join-Path $runtime 'Dorham.exe') -ArgumentList @('--user-data-dir="' + $profileWork + '"') -WorkingDirectory $runtime -WindowStyle Hidden -PassThru
  if (-not $process.WaitForExit(60000)) { Stop-Process -Id $process.Id -Force; throw 'Private migration helper timed out.' }
  if ($process.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $pending -PathType Leaf)) { throw 'Could not migrate protected profile; original data is preserved.' }
} finally { $env:DORHAM_MIGRATION_WORK=$previousWork; $env:DORHAM_MIGRATION_EXPORT=$previousExport; $env:DORHAM_MIGRATION_SOURCE_VERSION=$previousVersion; $env:ELECTRON_RUN_AS_NODE=$previousNode }
# Prove the helper operated on the work copy, never the immutable backup/source.
foreach ($relative in $hashes.Keys) {
  foreach ($root in @($profile,$backup)) { if ((Get-FileHash -LiteralPath (Join-Path $root $relative) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hashes[$relative]) { throw 'Original profile unexpectedly changed.' } }
}
if ($Validator) {
  $arguments = '--validate-electron-export "' + $pending + '"'
  $validation = Start-Process -FilePath (Full $Validator) -ArgumentList $arguments -WindowStyle Hidden -PassThru
  if (-not $validation.WaitForExit(15000)) { Stop-Process -Id $validation.Id -Force; throw 'The protected export could not be validated.' }
  if ($validation.ExitCode -ne 0) { throw 'The protected export did not pass the new Dorham profile checks.' }
  if (Test-Path -LiteralPath $destination) { [IO.File]::Replace($pending,$destination,$null) }
  else { [IO.File]::Move($pending,$destination) }
}
@{schema=1;sourceVersion=$sourceVersion;sourceProfile=$profile;profileBackup=$backup;exportFile=$destination;profileFiles=$hashes;originalProfileVerified=$true;originalBackupVerified=$true} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $work 'backup-verification.json') -Encoding UTF8
exit 0
