param(
  [switch]$Release,
  [switch]$SkipWeb,
  [switch]$SkipNativeHelpers
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$project = Join-Path $root 'apps\desktop-tauri'
$profile = if ($Release) { 'release' } else { 'debug' }
$target = Join-Path $project "target\$profile"

function Invoke-BuildTool([string]$Executable, [string[]]$Arguments) {
  & $Executable @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Executable failed with exit code $LASTEXITCODE" }
}

Push-Location $root
try {
  if (!(Get-Command cl.exe -ErrorAction SilentlyContinue)) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    $vcvars = @(& $vswhere -all -latest -products '*' -find 'VC\Auxiliary\Build\vcvars64.bat') | Select-Object -First 1
    if (!$vcvars) { throw 'Install the Visual Studio x64 C++ tools and Windows SDK.' }
    $developerVariables = & cmd.exe /d /c ('call "' + $vcvars + '" >nul && set')
    if ($LASTEXITCODE -ne 0) { throw 'Visual Studio environment initialization failed.' }
    foreach ($line in $developerVariables) {
      if ($line -match '^(PATH|INCLUDE|LIB|LIBPATH|WindowsSdkDir|WindowsSDKVersion|VCToolsInstallDir)=(.*)$') {
        [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')
      }
    }
  }

  if (!$SkipWeb) { Invoke-BuildTool 'node.exe' @('scripts/tauri-web-build.mjs') }

  if (!$SkipNativeHelpers) {
    $native = Join-Path $target 'native'
    $generated = Join-Path $project 'target\native-build'
    $headers = Join-Path $generated 'cppwinrt'
    New-Item -ItemType Directory -Path $native, $generated -Force | Out-Null
    $sdkVersion = $env:WindowsSDKVersion.TrimEnd('\')
    $cppwinrt = Join-Path $env:WindowsSdkDir "bin\$sdkVersion\x64\cppwinrt.exe"
    $metadata = Join-Path $env:WindowsSdkDir "UnionMetadata\$sdkVersion\Windows.winmd"
    Invoke-BuildTool $cppwinrt @('-input', $metadata, '-output', $headers)
    $csc = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    Invoke-BuildTool $csc @('/nologo', '/optimize+', '/platform:x64', "/out:$native\VoiceHotkey.exe", (Join-Path $root 'apps\desktop\native\VoiceHotkey.cs'))
    $compiler = @('/nologo', '/utf-8', '/std:c++20', '/EHsc', '/O2', '/MT')
    $fxc = Join-Path $env:WindowsSdkDir "bin\$sdkVersion\x64\fxc.exe"
    foreach ($shader in @(@('fullscreen', 'vs_4_0'), @('scaleFrame', 'ps_4_0'), @('packNV12', 'ps_4_0'))) {
      Invoke-BuildTool $fxc @('/nologo', '/T', $shader[1], '/E', $shader[0], '/Vn', $shader[0], '/Fh',
        (Join-Path $generated ($shader[0] + '.h')), (Join-Path $project 'native\CaptureScale.hlsl'))
    }
    Invoke-BuildTool 'cl.exe' ($compiler + @("/I$headers", "/I$generated", "/Fo$generated\CaptureVideo.obj", "/Fe$native\CaptureVideo.exe",
      (Join-Path $project 'native\CaptureVideo.cpp'), 'd3d11.lib', 'windowsapp.lib', 'user32.lib', 'gdi32.lib'))
    Invoke-BuildTool 'cl.exe' ($compiler + @('/DNOMINMAX', "/Fo$generated\ShareAudio.obj", "/Fe$native\ShareAudio.exe",
      (Join-Path $root 'apps\desktop\native\ShareAudio.cpp'), 'ole32.lib', 'mmdevapi.lib', 'uuid.lib', 'user32.lib'))
  }

  $cargo = if ($env:DORHAM_RUST_CARGO) { $env:DORHAM_RUST_CARGO } else { 'cargo.exe' }
  $cargoArguments = @('build', '--locked', '--manifest-path', (Join-Path $project 'Cargo.toml'))
  if ($Release) { $cargoArguments += '--release' }
  Invoke-BuildTool $cargo $cargoArguments
  Get-FileHash -LiteralPath (Join-Path $target 'Dorham.exe')
} finally {
  Pop-Location
}
