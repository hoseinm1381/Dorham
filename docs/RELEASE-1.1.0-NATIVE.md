# Android and Windows 1.1.0

Rebuilds the current Dorham application for both platforms against the released
Go 1.1.0 backend. No new feature is added. Additional work is reserved for 1.1.1.
The compact voice view, participant context-menu volume controls, self microphone
gain, chat-composer correction and other existing web changes are included.

## Update identities

Android retains package `com.dorham.chat` and the permanent RSA-3072 certificate
SHA-256 `2ae98de4ee027368967ec635684a41aab5915c71f4084deda77119138a62383c`.
Version name is 1.1.0 and version code is 1001000, above the published 1.0.6
code 1000006. Install over the existing app without uninstalling.

Windows retains application ID `com.dorham.chat`, product name Dorham and NSIS
uninstall GUID `26094eeb-aead-5f8d-b988-ece04b473a4b`. The existing per-user
installer updates the same directory and preserves app data. Windows remains
unsigned as previously selected by the operator.

## Verification and publication

Android release compilation, vital lint, APK signature verification, 16 KiB ZIP
alignment and all seven 64-bit ELF segment alignment checks pass. Physical
installation, login retention and microphone/speaker acceptance on the 1.1.0
APK have not been performed; previous Poco F3 acceptance applies to its earlier
release only.

Both packages contain the exact 135 current web files and matching native
modules. All 34 focused native tests, TypeScript and ESLint pass. The final
Windows ASAR was independently checked after a packaging-time file-change race
was detected and corrected by rebuilding from stable source.

A real isolated 1.0.7-to-1.1.0 installer upgrade keeps the same directory and
one uninstall entry. Login, Windows-encrypted credentials, server selection
and overlay preferences survive the upgrade. All 77 installed runtime files
match the package. The personal installation's 78 files and 85 profile files
remain unchanged; registry, shortcuts and updater cache were restored.

The installed Windows 1.1.0 passes English/Farsi chat, credential reload,
listen-only decoded voice, deafen/undeafen and real native window capture
decoded by a second client. Picker cancellation, retry, stop and restart pass.
This uses an owned animated window and local Go/mesh fixture; it does not
claim a new real-game overlay or production SFU acceptance. The browser guard
remains 4096 MiB with a 3500 MiB stop threshold; successful upgrade/runtime peaks
were 1274.2 and 2550.6 MiB. An earlier run stopped safely at that threshold
before the operator closed unused browser windows.

Public HTTPS installer hashes/ranges, download-menu links and actual native
online updater checks are recorded separately under
`artifacts/evidence/v110-native-*`.

Download publication replaces the four public release manifests only after
installer verification and a private metadata backup. It does not restart the
Go application, LiveKit, Caddy or HAProxy, or change the database, configuration
or either 1024 MiB service limit. Existing source, local installers and private
backups remain available for rollback.

Downloads: [Windows x64](https://dorhamapp.ir/downloads/1.1.0/Dorham-1.1.0-Windows-x64.exe)
and [Android APK](https://dorhamapp.ir/downloads/1.1.0/Dorham-1.1.0-Android.apk).
