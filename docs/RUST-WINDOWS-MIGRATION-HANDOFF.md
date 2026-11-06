# Paused Windows Rust migration

Paused by the operator on 2026-11-02: **stop the Rust migration and preserve the
work so it can be resumed later under a different version.** Do not resume,
build, publish or install it without a new request. The draft 1.1.1 numbering is
an abandoned working label, not a released or reserved version.

Windows, Android, web and the Go backend remain published **1.1.0**. Nothing
from this experiment was pushed to GitHub or deployed. Source baseline:
`3909cac0a2ee951cfeac64dc3a7d3842ce12f328`; published compiled branch:
`b0aabdba6fad92a6b46f02939f002a6675f8486c`.

## Preserved work and current state

Editable prototype: `D:\Dorham\apps\windows-rust`.
Build script: `D:\Dorham\scripts\windows-rust-build.mjs`.
Installer notes: `apps/windows-rust/installer/PAUSED-NOTES.md`.
Independent feasibility evidence:
`artifacts/evidence/v111-webview2-feasibility.json`.

A portable source snapshot, tracked-file experiment patch, checksums and logs
are saved under `artifacts/paused-rust-migration-2026-11-02/`, with an adjacent
ZIP of the same name. It excludes compilers, Cargo target/cache directories,
signing keys, account/profile data and private server material. The original
editable files and local toolchain caches remain in this workspace.

**The application has not compiled successfully or been run.** The last build
compiled the dependency stack, then failed because `src/hotkeys.rs` and
`src/overlay.rs` had not been implemented. Additional Rust type/API/integration
errors may appear after those missing modules are supplied. No Rust unit,
native media, installer upgrade or performance acceptance result exists.

No production or personal installation/profile/registry/shortcut changes were
made for this experiment. The installer agent started no migration/helper/test
process. Compiler/download sessions are finished; the final task-owned process
audit found nothing running (`artifacts/evidence/v111-pause-process-cleanup.json`).

## Architecture decision

Use a Rust Windows host with **Wry + Tao + Microsoft WebView2**, retaining the
existing React/TypeScript/CSS interface. This replaces the shipped Electron/Node
host, not the web UI or Go backend. Tauri was considered, but its default Windows
origin does not match the deployed backend's strict native-origin allowlist.

Map only bundled frontend assets to `https://localhost` using
`ICoreWebView2_3.SetVirtualHostNameToFolderMapping`, install handlers before final
navigation, then load `https://localhost/index.html`. That secure origin is
already accepted for native clients. Do not add wildcard/null origins, disable
web security or ignore TLS errors. [Microsoft local-content guidance](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/working-with-local-content)
and [Wry native Windows access](https://docs.rs/wry/0.57.1/x86_64-pc-windows-msvc/wry/trait.WebViewExtWindows.html)
describe the underlying APIs.

The proposed `window.desktop` bridge keeps the frontend's current contract.
COM permission/capture handlers restrict access to the exact trusted main frame;
child frames remain denied. WebView2's native screen picker replaces Electron's
custom source picker. Existing Windows screen-audio policy stays disabled
(`systemAudioSafe=false`); this experiment must not claim new loopback support.

## Source inventory and unfinished integration

- `Cargo.toml` / `Cargo.lock`: draft version 1.1.1, Wry 0.57.1, Tao 0.37.2,
  webview2-com 0.39.1, windows 0.62.2, tray-icon 0.26.1 and locked supporting
  crates. Release configuration is drafted; release compilation is untested.
- `src/main.rs`: draft window/event loop, IPC dispatch, tray/overlay/hotkey
  integration, single-instance mutex, session notifications, fullscreen and
  updater dispatch. **Not successfully typechecked.** Overlay/hotkey APIs are
  provisional; it still has unimplemented menu-action handling and assumed
  overlay constructor/method signatures.
- `src/bridge.js`: draft main-frame `window.desktop` compatibility API,
  request/reply promises, hotkey events and pre-React localStorage import.
- `src/settings.rs`: draft bounded settings/migration parsing, Windows CurrentUser
  DPAPI protection, atomic saves and credential APIs. Unit-test sources exist
  but were not run. Import currently accepts legacy source versions 0.7.6–1.1.0;
  reassess this bound for a later release.
- `src/updater.rs`: draft strict existing Windows manifest/URL/hash/size checks,
  bounded download and in-call installation guard. Unit-test sources exist but
  were not run. Actual installer dispatch and updater compatibility are untested.
- `src/media.rs`: draft WebView2 COM main-frame permissions, frame denial,
  capture and fullscreen handlers, with unexecuted unit tests.
- `src/tray.rs`: draft tray Open/Quit menu. The original Electron File/Edit/View/
  Window menus still need to be recreated and connected to the event loop.
- `src/hotkeys.rs` and `src/overlay.rs`: **missing**. Planned behavior below.
- `installer/`: draft existing-GUID NSIS packaging, official WebView2 prerequisite,
  pre-uninstall Electron migration helper, protected export and detailed notes.
  Neither exporter nor installer was tested. Reusing electron-builder as a build
  tool does not imply shipping Electron in the Rust runtime.
- `scripts/windows-rust-build.mjs`: draft asset/build/payload assembly script.
  The frontend generation completed, but Rust compilation failed before the
  binary/payload assembly stage. `--skip-web` assumes a prepared asset directory.

Two existing tracked files had experimental edits: `apps/web/vite.config.ts`
(optional validated `DORHAM_FRONTEND_VERSION`) and `scripts/browser-usage.ps1`
(include `msedgewebview2` in RAM accounting). Their modified copies and patch
are preserved in the snapshot; active files were restored to the 1.1.0 baseline
so these experiment changes do not affect routine development. Reapply the patch
deliberately when resuming. The Rust source/build script remains local and inactive.

## Mandatory credential and installer migration

Keep `com.dorham.chat`, product name Dorham, NSIS GUID
`26094eeb-aead-5f8d-b988-ece04b473a4b`, the existing per-user install directory
and one uninstall entry. The legacy Electron profile is
`%APPDATA%\@dorhamdesktop`.

Do not directly DPAPI-decrypt the existing `settings.secret`: Electron safeStorage
uses Chromium OSCrypt. Do not open a live Electron LevelDB profile with WebView2.
The proposed exporter clones the old runtime/profile privately, reads the secret
through the actual old Electron safeStorage API, exports only product
localStorage keys, protects the export with CurrentUser DPAPI, and preserves the
original profile and backup. It must run after the old app closes and **before**
the old uninstaller; export failure must leave the old app intact.
[Electron safeStorage documentation](https://www.electronjs.org/docs/latest/api/safe-storage)
and [Electron's encryption implementation](https://github.com/electron/electron/blob/v45.1.0/shell/browser/api/electron_api_safe_storage.cc)
support this distinction.

Agreed export: `%LOCALAPPDATA%\Dorham\migration\electron-export-v1.json`:
`{schema:1, appId:"com.dorham.chat", protectedPayload:"<CurrentUser-DPAPI base64>"}`.
Decrypted JSON contains `schema`, `appId`, `sourceVersion`,
`settings:{server,voiceOverlay}`, `secret` and `localStorage` string map.
Bounds: protected envelope 12 MiB, plaintext 8 MiB, individual preference 2 MiB.
Drafts use `dorham-drafts-v1`; retain all legitimate `dorham.` / `dorham-` keys.

Rust-owned state is proposed at `%LOCALAPPDATA%\Dorham\native`; import localStorage
before React mounts, re-protect credentials with DPAPI and mark migration once.
**Review UTF-8 byte versus JavaScript UTF-16 length limits before testing**:
the prototype exporter/importer use different per-value length measures.
Validate the complete import contract before uninstalling the old app. Prove
login/settings/drafts retention with a real isolated old-to-new upgrade and
independently preserved personal file/registry/shortcut hashes.

## Toolchain and network findings

Local-only installation; PATH and Visual Studio were not changed globally:

- Rustup/Cargo: `.tools/cargo/bin`; `CARGO_HOME=D:\Dorham\.tools\cargo`;
  `RUSTUP_HOME=D:\Dorham\.tools\rustup`.
- Rust **1.99.1** GNU host: `RUSTUP_TOOLCHAIN=1.99.1-x86_64-pc-windows-gnu`.
  Stable MSVC host was also installed, but Visual Studio C++ tools were absent.
- LLVM-MinGW **20261020**, `.tools/llvm-mingw-20261020-ucrt-x86_64`.
  Official ZIP 190612575 bytes; SHA-256
  `fd5462b7f5d93b2ff981fcd3f9c7e427e47f3203c64ea91c27bcc444eebd74cd`.
  Provenance JSON: `.tools/rust-install/llvm-mingw-provenance.json`.
- Use Rust's bundled GNU GCC **link driver** from
  `lib/rustlib/x86_64-pc-windows-gnu/bin/self-contained/`.
  Using LLVM UCRT Clang as the Rust GNU linker failed on `-lgcc_eh` / `-lgcc`.
- Use verified LLVM `x86_64-w64-mingw32-clang.exe` / `llvm-ar.exe` for C builds;
  set `CARGO_TARGET_X86_64_PC_WINDOWS_GNU_RUSTFLAGS` to
  `-C dlltool=D:\Dorham\.tools\llvm-mingw-20261020-ucrt-x86_64\bin\llvm-dlltool.exe`.
  Rust's bundled `dlltool.exe` otherwise failed spawning its assembler.
  With these settings, the dependencies compiled through Wry/Tao/reqwest.
- Microsoft-signed WebView2 bootstrapper is at
  `.tools/webview2/MicrosoftEdgeWebview2Setup.exe`; Authenticode was valid and
  Microsoft Corporation matched. Installer script checks it again before use.
- crates.io initially failed DNS; the operator enabled VPN, after which the
  official crates and lockfile downloaded successfully. Toolchains and crates
  are cached for reuse. No Rust advisory audit was performed.

Important logs: `artifacts/logs/v111-native-build.log` (latest actual failure),
`v111-rust-first-build.log`, `v111-rust-dependencies-build.log`,
`v111-cargo-fetch-vpn.log`, `v111-rust-gnu-vpn.log` and
`v111-llvm-download-final.log`.

## Resume gates, only after new authorization

1. Agree a new release version and review current stable source/native state;
   do not reuse the draft 1.1.1 label automatically. Preserve current rollback.
2. Reapply the two saved config changes, complete missing modules, resolve all
   Rust integration errors, run formatting/lint/unit/advisory checks and freeze
   source before packaging. Do not modify files while an installer is reading them.
3. Hotkeys: port the scoped selected-key/modifier 20 ms polling, held-key startup
   disarming, open/push/toggle modes, generation fences, release on stop/failure/
   lock/suspend/window loss; never record general keyboard/text input.
4. Overlay: reuse current transparent avatar/name/mic/headphone renderer in a
   separate unfocusable, topmost, click-through WebView2 window; retain positions,
   language, speaking/mute/deafen state and close-on-inactive/lock behavior.
5. Install all permission/security/session handlers before navigation; preserve
   native menus, external links, clipboard/downloads and fullscreen. Finish
   production-versus-diagnostic profile/CDP design before claiming release safety.
6. Run actual WebView2 UI/mesh/SFU tests: authentication/refresh, English/Farsi,
   all current feature contracts, mic permission/listen-only, decoded voice,
   mute/deafen/PTT/gain, input/output selection, real owned-window screen capture,
   picker cancellation/retry/stop/restart, background calls, tray and overlay.
   [Playwright WebView2 guidance](https://playwright.dev/docs/webview2) describes
   loopback CDP and isolated user-data folders.
7. Include **all `msedgewebview2.exe`** processes in memory measurements; retain
   the established 4096 MiB budget and 3500 MiB stop threshold. Compare matched
   Rust+WebView2 and Electron workloads; smaller installer alone is not RAM proof.
8. Prove actual in-place upgrade, encrypted login and preferences/drafts retention,
   one install entry, hash-matched installed payload, clean rollback and unchanged
   personal installation/profile. No such Rust upgrade acceptance exists yet.
9. Only after acceptance, prepare Windows-only manifests retaining the then-current
   Android release, public artifact/hash/updater checks and fresh metadata backup.
   Deployment/push needs a new explicit request because this migration was stopped.
