$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
try {
  $plain = [Console]::In.ReadToEnd()
  if ([Text.Encoding]::UTF8.GetByteCount($plain) -gt 8388608) { throw 'Migration data exceeds the supported size.' }
  $bytes = [Text.Encoding]::UTF8.GetBytes($plain)
  $protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Convert]::ToBase64String($protected))
} finally {
  $plain = $null
  if ($bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
}
