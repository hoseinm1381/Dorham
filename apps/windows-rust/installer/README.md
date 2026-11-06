# Windows runtime migration installer

This directory owns installer tooling only. The shipped application is the Rust
Wry/WebView2 binary and resources prepared by the application build. Electron
Builder is reused in `--prepackaged` mode solely to retain the tested NSIS update
identity. No Electron runtime belongs in the Rust distributable.

Stable identity: `com.dorham.chat`, NSIS GUID
`26094eeb-aead-5f8d-b988-ece04b473a4b`. The per-user installer reuses the prior
install folder and uninstall key, retains user data and shortcuts, and runs the
old uninstaller with its established update flags. Avoid Tauri's unrelated
default uninstall key, which would produce duplicate installations.

## Build

Prepare a directory containing `Dorham.exe` and the Rust application's required
resources. Obtain the official Microsoft Evergreen WebView2 bootstrapper and
set `DORHAM_WEBVIEW_BOOTSTRAPPER`, or place it at
`.tools/webview2/MicrosoftEdgeWebview2Setup.exe`. The packaging script verifies
its Authenticode status and Microsoft signer before including it. The installer
detects the runtime using Microsoft's documented HKCU/HKLM EdgeUpdate locations;
if absent it invokes the official bootstrapper before changing the existing app.

```powershell
node apps/windows-rust/installer/package.mjs --payload <prepared-directory>
```

An optional `--output` chooses an explicit generated artifact directory. The
default is `artifacts/v<version>/windows`. Packaging does not install the app or
read the operator's private profile. Native version changes are coordinated by
the release owner; this package currently targets 1.1.1.

## One-time profile import contract

The installer runs migration after its normal running-application check, before
the previous uninstaller removes the engine needed for export. It reads the
legacy `%APPDATA%\@dorhamdesktop` profile only after Dorham exits. A new private
directory under `%LOCALAPPDATA%\Dorham\migration\backups` retains an immutable
profile copy and a verified per-file SHA-256 manifest. Reparse points cause an
abort instead of following a link outside the intended profile/runtime.

The previous Electron engine and a second working profile copy are cloned in
that private directory. The clone loads only `export-electron.cjs`, with all
HTTP/WebSocket requests blocked. The helper uses the original Electron
`safeStorage` and `dorham://app` localStorage APIs. Chromium LevelDB files and
OSCrypt blobs are never guessed, rewritten or directly handed to WebView2.

The helper writes only this envelope to
`%LOCALAPPDATA%\Dorham\migration\electron-export-v1.json`:

```json
{"schema":1,"appId":"com.dorham.chat","protectedPayload":"base64 Windows DPAPI CurrentUser data"}
```

Decrypting that blob with Windows `CryptUnprotectData` under the same Windows
account yields UTF-8 JSON:

```json
{"schema":1,"appId":"com.dorham.chat","sourceVersion":"1.1.0","settings":{"server":"https://dorhamapp.ir","voiceOverlay":{"enabled":true,"position":"top-left"}},"secret":"refresh-token-or-null","localStorage":{"dorham.language":"fa-IR"}}
```

`secret` is nullable. All current product localStorage keys, including drafts,
begin with `dorham.` or `dorham-`. Keys are bounded to 256 characters, individual
values to 2 MiB of UTF-16 units, and the complete UTF-8 plaintext to 8 MiB. The
envelope is therefore bounded below 12 MiB. Unrelated origin keys are excluded.
UTF-8 is explicitly selected on the PowerShell protection pipe to preserve
Persian text. No token is printed, put in a command-line argument, or written as
a plaintext export file.

The Rust shell must validate schema/appId, import only recognized settings,
protect the refresh secret into its own store, and inject localStorage before
React mounts at the new `https://localhost` origin. It must persist an import
completion marker, consume the export once and never overwrite a newer Rust
session with an old export. A failed import must preserve the envelope/backup
for recovery. Login then follows the existing native refresh flow. A copied
profile does not revive a revoked or expired server session.

The profile and rollback engine remain private local backups. They are not
included in downloads/Git. Further Rust-to-Rust upgrades skip the Electron
export because the installed application no longer contains `resources/app.asar`.

## Source provenance

`installer.nsi` and `installSection.nsh` derive from the installed, pinned
`app-builder-lib` 26.18.0 templates. The only template change adds a
`customBeforeUninstall` hook immediately before `uninstallOldVersion`, after
`CHECK_APP_RUNNING`. Other includes resolve from that pinned package.

Official references:

- [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)
- [Electron 45.1.0 implementation](https://github.com/electron/electron/blob/v45.1.0/shell/browser/api/electron_api_safe_storage.cc)
- [Electron Builder CLI and prepackaged mode](https://www.electron.build/v26/docs/cli/)
- [Electron Builder NSIS identity/customization](https://www.electron.build/nsis/)
- [Microsoft WebView2 distribution/detection](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)

Package/static checks, synthetic migration, actual installer upgrade and physical
device acceptance are separate gates; merely building the installer proves none
of the latter three.
