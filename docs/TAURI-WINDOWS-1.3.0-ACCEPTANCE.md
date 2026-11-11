# Dorham Desktop 1.3.0 Windows acceptance

## Baselines

- Public Windows feed checked on 2026-11-11. It advertised Electron 1.2.8, app ID `com.dorham.chat`, 122,764,753 bytes, SHA-256 `d2b68cac2e234dc3e5d136e9a63fc7084cfbc892ca8c5811789a35ffd5a8f8d6`. A full streamed public download and the local release copy matched. [Windows release feed](https://dorhamapp.ir/downloads/windows.json)
- Repository base is `31d54233ed0fc429485bd26f242171876717661d`, the 1.2.7 commit and the remote main head observed at the start of the port. The isolated `codex/dorham-1.3.0-tauri` worktree includes a copy of the original checkout's 1.2.9 tracked edits and untracked source. The original checkout's Git status fingerprint matched before and after copying. A separate Git commit for the 1.2.8 installer was not located.
- The public 1.2.8 `app.asar` matched the current source after newline normalization for `main.cjs`, `preload.cjs`, `screen-capture.cjs`, `capture-origin.cjs`, `voice-hotkeys.cjs`, `voice-overlay.cjs`, `updater.cjs`, `capture-picker.js`, and `overlay-renderer.js`. The 1.2.9 worktree includes frontend and game/version-gate changes beyond that Electron payload.
- Existing Windows limits include video-only capture on Windows 10 build 19045, and an overlay intended for windowed or borderless games. A 1.2.9 artifact exists locally. The public feed points to 1.2.8.

## Bridge inventory

The Electron preload is the contract baseline. Each row lists the native responsibility and the remaining qualification for the packaged candidate.

| Electron methods and events | Tauri implementation and behavior | Qualification |
|---|---|---|
| `getServer`, `setServer` | Main-window IPC reads and writes native settings. HTTPS and loopback HTTP are accepted. Changing the selected server clears the stored credential. | Isolated WebView2 login exercised reading the selected server. Switch and relaunch pending. |
| `getSecret`, `setSecret` | DPAPI CurrentUser storage through the trusted main document. Electron export uses the old runtime's safeStorage. | Development login, refresh and secret presence verified. Install-over and logout pending. |
| `setLanguage` | Updates tray text. Bundled frontend continues to own locale and RTL preferences. | English login passed. Persian UI and tray pending. |
| `getAppInfo` | Tauri package version and Windows platform report. Windows-specific frontend build reports 1.3.0. | Version 1.3.0 checked through real WebView2. Packaged version gates pending. |
| `setInCall` | Host activates hotkeys and overlay, manages tray and close behavior, gates capture, and pauses updates. | Call lifecycle, second launch, lock/suspend and fault recovery pending on package. |
| `onVisibility` | Window show, minimize, focus and tray visibility emitted to the main renderer. | Tray and minimized background call behavior pending. |
| `configureVoiceHotkey`, `onVoiceHotkey` | Existing VoiceHotkey helper, selected Windows key only, generation checks, heartbeat timeout, release and error events. | Real input and held-key disarming in another app, lock, sleep, and helper exit pending. |
| `getOverlay`, `configureOverlay`, `updateOverlay`, `onOverlayPreferences` | DPAPI-independent overlay preferences and existing renderer in a click-through, non-activating window. | Avatar/status updates, click-through, position, DPI and visibility pending. |
| `getCaptureCapabilities` | Native host exposes process-loopback capability only on supported builds with the helper present. | Windows 11 and Windows 10 packaged results pending. |
| `getCaptureSelection`, `chooseCompatibilitySource` | Shared media uses the Tauri capture entry point for source label and scope. The Electron fallback contract remains in shared media. | Win32 scoped selection and video frames proved in the standalone helper. Receiver, picker thumbnails and Windows 10 pending. |
| `startCaptureAudio`, `stopCaptureAudio`, `acknowledgeCaptureAudio`, `onCaptureAudio` | One-use audio grant for the selected video, bounded PCM packets, app process loopback and WebView2 browser-process exclusion for system capture. | Native two-client spectral scope and cleanup pending. |
| `checkUpdate`, `getUpdateState`, `prepareUpdate`, `installUpdate`, `onUpdateState` | Existing Windows feed, exact installer URL and identity, resumable staging, size/SHA-256 verification, and call guards. | Successor fixture, interruptions, tampering, resume, restart and installed rollback pending. |

## Acceptance matrix

The Windows 11 bridge and product checks below ran on development executables. The release-profile installer has static payload checks. Packaged runtime qualification is open.

| Requirement | Baseline and test environment | Observed result and evidence |
|---|---|---|
| Secure app origin, HTTP and Socket.IO | Public 1.2.8 feed, Windows 11 build 26100, WebView2 and isolated Go backend | Production returned HTTP preflight 204 and Socket.IO polling 200 for `https://localhost`. Tauri's default HTTPS origin returned 403 on both. The Tauri development build loaded embedded assets at `https://localhost`, registered an owned account, logged in, connected Socket.IO and retained login on reload. See `tests/tauri-webview-smoke.ts`. |
| Shared build and tests | 1.2.9 source snapshot, Node 24.22.1 and local Go toolchain | Vite built the Windows frontend and Go built and passed its test suite. Vitest passed 257 tests. The test bootstrap now supplies the normal Vite client-version constant. |
| Windows Graphics Capture | Windows 11 build 26100, two owned test windows | The standalone helper decoded two distinct colors in the chosen window, excluded the other window, stopped on source destruction and rejected a stale HWND. The first teardown crash was corrected by revoking capture events before closing WinRT capture objects. See `tests/tauri-capture-helper.mjs`. |
| WebRTC screen-share bridge | Windows 11, isolated WebView2 and an owned animated window | The first run timed out before frame delivery. The retest with scoped WebView2 binary resource responses decoded selected-window video at a WebRTC receiver, rejected capture outside a call, and ended the track when the source closed. See `artifacts/v1.3.0/evidence/webview2-bridge.log`. |
| Windows scoped PCM | Windows 11, selected and unrelated native tone windows plus WebView2 playback | Application-only capture contained 400 Hz and excluded 700 Hz and 1100 Hz. System capture contained 400 Hz and 700 Hz and excluded WebView2's 1100 Hz tone. These measurements are at the native-to-WebView2 bridge. See `artifacts/v1.3.0/evidence/windows-audio-scope.log`. |
| Dorham mesh sharing | Windows 11 WebView2 development build and Edge receiver, isolated Go server | The receiver decoded selected-window video and the selected app's tone twice. Picker cancellation and stop/restart passed. The diagnostic profile denied microphone access through the native permission handler and entered listen-only mode. See `artifacts/v1.3.0/evidence/mesh-product-sharing.log`. |
| Dorham LiveKit sharing | Windows 11 WebView2 development build and Edge receiver, isolated Go and real LiveKit services | The receiver decoded selected-window video and the selected app's tone twice. Picker cancellation, stop/restart, and listen-only passed. The fixture enabled loopback ICE and disabled local IP obfuscation for the two test browser processes. See `artifacts/v1.3.0/evidence/livekit-product-sharing.log`. [LiveKit configuration sample](https://github.com/livekit/livekit/blob/master/config-sample.yaml) |
| Protected Electron profile export and import | Public Electron 1.2.8 runtime, isolated Windows 11 profiles and Go account | The production NSIS migration macro found the scoped roaming profile and generated a Windows DPAPI-protected export. The packaged Dorham executable validated the export. The Tauri development build opened the same account without a password prompt, stayed signed in after a restart, and retained the selected server, an unsent Persian draft, language, hotkeys, sound preferences and overlay position. See `artifacts/v1.3.0/upgrade-validation/legacy-installer-hook.log`. |
| Per-user NSIS build | Electron 1.2.8 installer identity and Windows 11 MSVC/NSIS packaging | The corrected unsigned x64 test installer is 12,166,479 bytes. Extraction matched the SHA-256 of Dorham.exe and all three Windows helpers. The package has app ID `com.dorham.chat` and NSIS GUID `26094eeb-aead-5f8d-b988-ece04b473a4b`. See `artifacts/v1.3.0/upgrade-validation/installer-static.json`. |
| Product and session coverage | Electron 1.2.8 and final Tauri package, owned profiles and Go accounts | The isolated clean-profile login and migrated-session restart passed in development. Packaged registration UI, logout, server switching, private chat/calls, attachments, clipboard, downloads, fullscreen, links, TTS, games and both locales remain pending. |
| Voice and lifecycle | Windows 10 and 11, two clients, mesh and LiveKit, real mic and audio outputs | Pending bidirectional audible voice, denied mic/listen-only, mute/deafen, gain, device routing, reconnect, tray, overlay, lock, sleep, resume, helper and renderer faults. |
| End-to-end screen sharing | Windows 10 and 11, two clients, owned window/monitor sources and distinguishable tones | Packaged qualification pending. Windows 10 is unavailable for this run, as confirmed by the operator. |
| Clean install and install-over | Public 1.2.8 installer and Tauri 1.3.0 package in isolated Windows users/VMs | Pending installer execution, WebView2 provisioning, shortcuts, single uninstall entry, validation before uninstall, imported profile, restart and retry. The active Windows 11 account was available for portable profile tests. A disposable Windows installation account or Sandbox was unavailable. |
| Updates and rollback | Isolated successor feed, preserved public Electron installer and release metadata | Pending staging, tampered/interrupted bytes, in-call protection, restart-to-update, feed rollback and installed downgrade rehearsal. Restored Electron may need a fresh login after Tauri rotates the refresh token. |
| Performance | Matched Electron and Tauri workloads with all owned helper and WebView2 processes | Pending sustained idle, voice, tray, overlay and screen-sharing CPU, memory, frame delivery and resource release. |
| Production | Approved installer and matching Windows-only metadata | Awaiting packaged acceptance and explicit approval of the exact installer hash. |

## Local package

`artifacts/v1.3.0/upgrade-validation/windows/Dorham-1.3.0-Windows-x64.exe`

SHA-256 `53d0caa57a52ee1c79e224a26a1ab010555b510a6b9f1ef5edffb0d865a974fe`

The initial test installer in `artifacts/v1.3.0/windows` used `%APPDATA%\@dorhamdesktop` and silently skipped migration from Electron's actual `%APPDATA%\@dorham\desktop` profile. The earlier migration test supplied the profile path directly. The regression reproduced the missing export through the NSIS macro, then passed after the path correction. The complete per-user install-over and rollback flows require a disposable Windows user or VM.

The local Windows-only catalog still references the initial test build. The saved public baseline metadata is under `.tools/public-feed-1.2.8`. The installer uses a per-user one-click flow and reuses the existing Electron installer identity. WebView2 can ask the user to grant microphone access for its profile. Picker thumbnails and browser-specific audio device ID migration remain open.

The final Windows 11 development executable used for the two-client mesh and LiveKit checks had SHA-256 `0a2827454400ee8428ba3594dd4714f3c9e0bd1979a39897f73501c4ae642791`. The extracted release-profile Dorham.exe had SHA-256 `d2346caa6fbfb0f1e75bc4789b418d3ea26150b1c0db28ba52e642e53fa4dbf8`. Its interactive runtime checks remain open.

Use `scripts/tauri-windows-build.ps1 -Release` with the x64 MSVC and Windows SDK tools, then `node scripts/tauri-windows-package.mjs` with the signed WebView2 bootstrapper specified by `DORHAM_WEBVIEW_BOOTSTRAPPER`. The Tauri Windows version comes from its own Cargo and Tauri manifests.

## Rollback procedure to rehearse

1. Before rollout, save the live `windows.json`, `latest.json`, `android.json` and `releases.json` and confirm the archived Electron installer still matches the public 1.2.8 size and SHA-256 above. Preserve its public URL.
2. To stop new updates, restore the saved Windows feed and catalog and verify the public routes and hashes. Clients already on 1.3.0 need the installed-client recovery procedure.
3. In an isolated Windows user, close 1.3.0, use its per-user uninstall entry, and reinstall the verified 1.2.8 installer. Confirm a single uninstall entry, both shortcuts, the retained Electron profile, and the selected server and preferences. Test the earlier account's login and any fresh sign-in needed after refresh-token rotation.
4. Compare Electron's original profile with the preserved migration backup. Changes created in Tauri belong to its separate profile. Record which settings and drafts are visible after downgrade and subsequent upgrade before approving the recovery procedure.

An isolated installed rollback rehearsal is pending.

## Overlay and capture follow-up

The pre-fix development build saved the overlay preference and then stopped answering a desktop command in the Windows 11 regression. The preference event led to the renderer's first overlay state update, which invoked synchronous WebView2 window creation. The corrected implementation builds one hidden window on a worker and reconciles the current preference, participant state and call state on the UI thread before showing it. The native smoke test covers enabling during a call, joining with the preference enabled, rapid toggles, disabling during creation, leave and rejoin, the participant row, click-through styles, focus and the Windows lock and unlock messages. It checks the message handler with a targeted test message to the owned window.

The earlier application-audio sample attributed 53.76% of one logical core to WebView2, 26.54% to the Dorham host, 2.03% to `CaptureVideo.exe`, and 1.36% to `ShareAudio.exe`. The capture helper still reads and scales the same BGRA frames at the selected quality. The host and trusted main WebView now reuse a read-only shared mapping for video. The existing binary response is the compatibility path when shared buffers are unavailable. Stop releases the mapping and aborts in-flight renderer requests. [WebView2 shared buffers](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/javascript/sharedbufferreceivedevent)

The matched Windows 11 development runs used the same animated window and mesh backend with audio disabled. The picker IDs matched the owned HWND on both runs. CPU is percent of one logical core. Memory values sum the private bytes or working set for the publisher process tree. Active sharing shows the mean of two start/stop cycles per build. The other rows are individual observations.

| Workload | CPU before → after | Private MiB before → after | Working set MiB before → after |
|---|---:|---:|---:|
| Signed-out idle | 3.6 → 2.3 | 220.6 → 223.4 | 416.0 → 418.1 |
| Signed-in idle | 0.2 → 0.2 | 275.2 → 269.3 | 482.9 → 473.3 |
| One-client voice | 5.4 → 2.1 | 283.5 → 284.7 | 523.3 → 517.6 |
| Two-client listen-only voice | 3.8 → 2.9 | 267.8 → 266.7 | 518.3 → 513.0 |
| Video-only sharing | 34.7 → 32.0 | 520.1 → 393.6 | 771.1 → 666.7 |
| Voice after 30-second cooldown | 3.2 → 3.4 | 472.2 → 274.3 | 725.2 → 525.7 |

At 502 × 315, the old build delivered 10.6 fps in both cycles and reported zero drops. The new build delivered 10.3 and 10.4 fps with zero and nine reported drops. Dorham host CPU averaged 17.5% before and 3.0% after. The renderer and encoder accounted for more CPU in the new samples. The new run transferred all 339 frames through the shared mapping with zero video HTTP body bytes, compared with 176.5 MB in the old run. Private memory after cooldown was 204.4 MiB above the pre-share voice sample before the change and 7.6 MiB above it afterward. These two cycles establish memory recovery for this workload. Long-run retention and screen sharing with audio on the new build remain open. The raw evidence and per-process timings are in `before/video-only-before.json`, `before/video-only-after.json`, and `video-only-summary.jsonl` under the benchmark directory.

The separate unsigned x64 test installer is `artifacts/v1.3.0/overlay-perf/windows/Dorham-1.3.0-Windows-x64.exe`. Its SHA-256 is `3d5e27457fdcda54b96eca06630255e7dddcbb76ffa1299e08cf292f21d2e741`. It is 12,185,542 bytes versus 122,764,753 bytes for the public Electron installer. The extracted runtime is 15,107,584 bytes versus 378,286,696 bytes for Electron. All four packaged binaries matched the release build inventory. There are no new runtime dependencies.

The benchmark files and native smoke logs are under `artifacts/v1.3.0/overlay-perf`. Audio testing was paused at the operator's request. The Windows 10 video-only check and full release-executable and installer checks in a separate Windows user or VM remain pending.

The main WebView2 runs while the app is idle. The overlay and picker WebViews are created on demand. Screen video and audio polling start with a share and the capture helpers are absent from the post-share samples. The renderer collects call diagnostics only while the Diagnostics panel is open and visible. During a background call the main WebView and media connection stay active.

The Windows 11 development build passed silent second-client video decoding over mesh and LiveKit, with picker cancellation and two share cycles on each transport. It also passed the binary-response video path and stopped its track on source closure. The release executable extracted from the installer validated the protected export from the public 1.2.8 runtime. The development executable then restored the same account, draft and settings and retained the login after restart.
