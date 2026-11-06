# Paused Windows Rust migration discoveries

Paused on 2026-11-02 at the user's explicit cancellation. Save/resume notes only.
Do not resume builds, tests, installation, Git changes or publication until the
user requests a new version/task. Version 1.1.1 in these prototype files is an
abandoned target, not a release. Existing published Windows/Android 1.1.0 are
outside the paused prototype.

## State and cleanup

This installer subagent started **no** Rust build, migration test, installer,
Electron export helper or synthetic profile process. No active owned process IDs
exist. No personal app/profile, registry, shortcuts or production server were
touched by this installer work. Therefore there is no installer/profile/registry
restoration or test-process cleanup to perform for this subagent.

Only source files in this directory were created/edited. No preserved backups or
local work were deleted. A `--rust-migration` browser-guard selector was approved
but had **not been added** when cancellation arrived. The synthetic migration
test driver had **not been written or run**. Earlier 1.1.0 publication tests are
separate completed work and must not be described as Rust acceptance.

## Confirmed discoveries

- Existing Windows identity is app ID `com.dorham.chat`, NSIS GUID
  `26094eeb-aead-5f8d-b988-ece04b473a4b`. Reusing the existing per-user NSIS
  installer identity is necessary to upgrade the same folder/uninstall entry.
- The legacy Electron profile location was confirmed by the root agent as
  `%APPDATA%\@dorhamdesktop`, **not** `%APPDATA%\Dorham`.
- The published 1.1.0 executable reports ProductVersion `1.1.0.0` but FileVersion
  `1.1.0`. The prototype exporter normalizes FileVersion to a numeric triple.
- Electron 45.1.0 `safeStorage` delegates to Chromium OSCrypt and recognizes
  versioned `v10`/`v11` ciphertext. Calling Windows `CryptUnprotectData` directly
  on the existing `settings.json.secret` blob is not a valid general importer.
  Original Electron APIs plus its copied profile are the proposed bridge.
- Chromium localStorage uses LevelDB. Copying that directory into WebView2 does
  not migrate origin data. Export through `dorham://app` and inject values before
  React mounts at the new shell's `https://localhost` origin instead.
- Every observed product localStorage key begins `dorham.` or `dorham-`, including
  account-specific audio choices and `dorham-drafts-v1`. Draft storage permits up
  to 1 MiB, so a 256 KiB per-value export cap would lose legitimate drafts. The
  prototype uses 2 MiB individual value and 8 MiB total UTF-8 plaintext limits.
- An explicitly UTF-8 PowerShell stdin/stdout pipe is necessary to preserve
  Persian text while DPAPI-protecting the exported JSON.
- WebView2 Evergreen must be detected/provisioned; Windows 11 commonly includes
  it but that is not a distribution guarantee. The official Microsoft runtime
  bootstrapper is approximately 2 MB. Packaging should verify its Microsoft
  Authenticode signer, then embed it for machines missing the runtime.

Official references are linked in [README.md](README.md).

## Prototype source files

- `electron-builder.yml`: existing-identity NSIS packaging of a prebuilt Rust
  payload. This reuses Node/Electron Builder **as packaging tooling only**; the
  distributable must contain no Electron runtime.
- `package.mjs`: verifies a prepared `Dorham.exe` payload and official signed
  WebView2 bootstrapper, invokes `electron-builder --prepackaged`, records file
  hashes. Never executed. It rejects known Electron runtime files in payload.
- `installer.nsi`, `installSection.nsh`: copied from pinned app-builder-lib
  26.18.0. The sole template alteration introduces `customBeforeUninstall`
  immediately before `uninstallOldVersion`, after `CHECK_APP_RUNNING`.
- `migration.nsh`: proposes WebView2 prerequisite handling plus that hook. An
  export failure aborts before removing the previous app.
- `migrate-electron.ps1`: proposes a private immutable profile backup, verified
  hashes, a separate working copy and a cloned old engine. Original profile and
  backup are rehashed after export. Reparse points fail closed. Not executed.
- `export-electron.cjs`: runs only in the private engine/profile clone, replaces
  product app entry in that clone, blocks HTTP/WebSockets, decrypts with actual
  Electron safeStorage and reads product localStorage. Not executed.
- `protect-export.ps1`: receives JSON over stdin and returns only a CurrentUser
  DPAPI-protected base64 envelope payload. Not executed.

## Agreed import contract

Root approved this private export path:
`%LOCALAPPDATA%\Dorham\migration\electron-export-v1.json`.

```json
{"schema":1,"appId":"com.dorham.chat","protectedPayload":"base64 CurrentUser DPAPI ciphertext"}
```

Decrypting under the same Windows user yields UTF-8 JSON with:

```json
{"schema":1,"appId":"com.dorham.chat","sourceVersion":"1.1.0","settings":{"server":"https://dorhamapp.ir","voiceOverlay":{"enabled":true,"position":"top-left"}},"secret":"refresh-token-or-null","localStorage":{"dorham.language":"fa-IR"}}
```

The root agent selected a Rust Wry 0.57 + Tao/WebView2 shell, rather than Tauri,
and owns `apps/windows-rust/src/settings.rs`. Root reported implementing an
importer accepting schema/app ID, supported legacy versions 0.7.6 through 1.1.0,
8 MiB plaintext/12 MiB envelope, known settings, the refresh secret and exported
localStorage. That implementation is **not verified by this installer subagent**.
New Rust settings were planned at
`%LOCALAPPDATA%\Dorham\native\settings.json`.

Import must protect the secret in the new store, restore localStorage before
React starts, persist a completion marker and consume only once. It must never
overwrite a newer Rust session with a stale export. Retain private original
profile/rollback engine for recovery. A revoked/expired server session remains
revoked/expired; migration must not claim otherwise.

## Unfinished next steps, only after a new user request

1. Read the root pause/archive handoff and select the newly authorized version;
   do not accidentally publish the abandoned 1.1.1 target.
2. Review and compile-check the prototype scripts/templates. In particular verify
   local `installSection.nsh` include resolution, NSIS package metadata, exact
   bootstrapper detection/exit semantics, private clone ACL behavior and failure
   cleanup. No installer compilation currently proves these work.
3. Add a synthetic test driver and approved guarded-launcher selector. Seed a
   fresh owned Electron profile using actual safeStorage and localStorage with a
   synthetic refresh token, Persian/English settings and a large draft. Never
   point the test at a personal profile.
4. Run the full proposed exporter on that owned fixture; decrypt its envelope
   privately, assert exact token/settings/Unicode/draft preservation and exclusion
   of unrelated keys. Confirm no plaintext token in export, immutable source and
   backup hashes, idempotent retry and rejection of tampered DPAPI ciphertext.
5. Exercise the real Rust importer and refresh/login path against an isolated
   backend. Verify origin initialization timing and completion-marker behavior.
6. Compile the actual Rust NSIS package; perform a separately backed-up isolated
   1.1.0-to-new-version upgrade with registry/shortcut restoration. Verify same
   directory/GUID, exactly one uninstall entry and unchanged personal files.
7. Verify feature parity and resource usage, rollback, public hash-checked native
   updates and manifests before any future publication. Existing Android must
   remain unchanged unless that future task explicitly includes it.

No Rust installer/migration runtime success, native feature parity, memory
improvement or release readiness is established by this paused source work.
