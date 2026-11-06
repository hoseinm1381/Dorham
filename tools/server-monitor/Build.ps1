param([switch]$Portable)
$ErrorActionPreference = 'Stop'
$project = Join-Path $PSScriptRoot 'Dorham.Monitor.csproj'
$version = ([xml](Get-Content -LiteralPath $project -Raw)).Project.PropertyGroup.Version
$destination = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\artifacts\server-monitor\windows-x64-$version"))
& dotnet restore $project -r win-x64 --locked-mode -p:SelfContained=true -p:PublishSingleFile=true
if ($LASTEXITCODE -ne 0) { throw 'Locked dependency restore failed.' }
$arguments = @('publish', $project, '--no-restore', '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', '-p:PublishSingleFile=true', '-p:IncludeNativeLibrariesForSelfExtract=true', '-p:EnableCompressionInSingleFile=true', '-p:DebugType=None', '-o', $destination)
& dotnet @arguments
if ($LASTEXITCODE -ne 0) { throw 'Windows publish failed.' }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'README.md') -Destination $destination
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\..\docs\FEATURES.md') -Destination $destination
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'THIRD-PARTY-NOTICES.md') -Destination $destination
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'licenses') -Destination $destination -Recurse -Force
if ($Portable) {
    Compress-Archive -Path (Join-Path $destination '*') -DestinationPath (Join-Path (Split-Path $destination) "Dorham-Monitor-$version-Windows-x64.zip") -CompressionLevel NoCompression -Force
}
Write-Host "Ready: $destination"
