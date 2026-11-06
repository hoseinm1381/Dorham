# Android 1.1.1 — published

Published 4 November 2026 at `https://dorhamapp.ir`, after the user reported that the candidate worked perfectly so far on Poco F3 / Android 13 and explicitly authorized server publication. This release extends the shared web/Windows 1.1.1 work without replacing their published packages. The signed APKs are identical to the device-tested candidate.

- [Poco F3 / ARM64 download](https://dorhamapp.ir/downloads/1.1.1/Dorham-1.1.1-Android-arm64.apk)
- [Universal Android download](https://dorhamapp.ir/downloads/1.1.1/Dorham-1.1.1-Android.apk)
- [Android update feed](https://dorhamapp.ir/downloads/android.json)

## Packages

| Variant | File | Bytes | SHA-256 |
| --- | --- | --- | --- |
| ARM64, suitable for Poco F3 | `artifacts/android-1.1.1/arm64/Dorham-1.1.1-Android-arm64.apk` | 30,317,898 | `1f3b776b2ce5956945f526ee20fd8646be6c99f2145b067d44e3ca287233a044` |
| Universal | `artifacts/android-1.1.1/universal/Dorham-1.1.1-Android.apk` | 70,061,731 | `8839721c806414c33cf1a6e5d1e70b1372b441c6a63aee728b7cb5858016e779` |

Package remains `com.dorham.chat`, version name 1.1.1, version code 1001001. Both use the permanent RSA-3072 certificate SHA-256 `2ae98de4ee027368967ec635684a41aab5915c71f4084deda77119138a62383c`. Install over the existing app; do not uninstall. The ARM64 APK is approximately 57% smaller in download size than the universal APK. This does not establish a runtime-memory or battery saving. Later canonical updater packages can remain universal.

## Implemented areas

1. **Mobile channels and calls.** Preview a channel and its occupants before joining; visible participant strip; real members sheet; persistent bottom call controls and Home/Channels/Members navigation. Closed Android drawers are inert. Participant actions reuse existing server authorization. Larger controls, keyboard-safe layout and native Back handling are included.
2. **Screen sharing and viewing.** Native local and remote video descriptors connect to TextureView renderers. Layout follows the web view, including clipping to scroll containers; dialogs and backgrounding remove native renderers. Own preview can be shown independently of capture. Fullscreen and Back are connected. Android 13 whole-phone sharing is explained; portrait sizing preserves device aspect ratio within the existing capture limit. Native stream sound volume is separate from microphone volume.
3. **Phone audio and lifecycle.** Real Android route discovery/selection replaces browser microphone IDs. Unsupported processing/hotkey controls no longer pretend to apply. SFU speaking and connection-state events are forwarded. Native speech playback uses the communication route. Foreground notifications provide localized mute, stop-share and disconnect actions. A call-scoped, bounded/renewed partial wake lock is released on service destruction. This is not a physical Doze or OEM-background acceptance result.
4. **Performance, downloads and release checks.** Current shared composer/history/status/TTS-progress improvements are bundled. Mesh full-stat polling is reduced from 250 ms to one second, and speaking transitions are deduplicated. Unselected video is unsubscribed and hidden renderers are removed. APK ABI filtering is available. Native updater stages on non-metered connections, reports progress, supports cancel/range resume, verifies package/version/certificate/size/SHA and rechecks before installation; native call guards protect installation. Attachment download progress/cancel is included.

For phone playback sound, `ScreenAudioPublisher` uses a separate, publish-only LiveKit engine. Physical microphone recording is disabled in that auxiliary engine. Android playback capture excludes Dorham's UID. PCM is cleared before each read, including silence/short-read cases. The backend restricts its identity to `user:epoch:screen:lease`; it cannot subscribe to media or publish microphone video/audio. Android mesh remains video-only for outgoing phone sound.

## Backend dependency and unconfigured services

Follow-up: the [Android 1.1.2 candidate](RELEASE-1.1.2-ANDROID.md) implements built-in direct notifications as an alternative to Firebase. Its backend is active and physical acceptance is pending. The Firebase limitation below describes the original 1.1.1 APK.

The active Linux backend is `artifacts/android-1.1.1/backend/dorham`, SHA-256 `b55c260783cd07f17ffd36c67fbe00b622c0c1043ed6251782bc374e0fc53246`. The new auxiliary-audio grant requires this backend revision. It passed final production verification and is **active**. The APK negotiates `nativeScreenAudio` and leaves Share sound unavailable against older backends, preventing an auxiliary connection from accidentally reusing the primary identity.

Early rollback-protected activation attempts did not pass live verification and restored the prior backend. LiveKit logs identified a temporary `RemoveParticipant` / `503 unavailable` control failure. The revised backend retries an idempotent control request once for that code and still propagates persistent failures; permission denials and missing participants are not retried. The full Go suite passes, including transient recovery, bounded persistent failure and unchanged permission-denial behavior. A later cached-speech check incorrectly attributed shared production-worker CPU to one cached message; the probe now verifies that message's exact non-synthesis progress phases and identical audio bytes, while retaining the shared CPU-cap check. Heartbeat measurement stops before the test's intentional leave/rejoin. The signed APKs are unchanged from the device-tested candidate. The original publication archive and rollback backups are retained.

No speech worker/model/configuration or database schema change was required. Existing media admission is retained and extended for exact auxiliary lease identities. The backend was verified before promoting Android manifests. Existing Windows installer bytes and its dedicated manifest, website shell, speech files, system configuration and service limits were preserved. Only Dorham was restarted; LiveKit, Caddy and HAProxy retained their processes. The final pre-activation backend and consistent database backup are retained under `/var/lib/dorham-ops/backups/android-before-aae8da07131a`; previous catalogs are under its `catalog-before` directory. Database rollback was not needed, and current user data was preserved.

No Firebase project exists. Native call notifications and private connected-message alerts/settings are implemented. **Closed-app push delivery and its Firebase/backend integration remain outstanding**, rather than being described as a working feature. The settings explain this limitation. The HTTPS `.well-known/assetlinks.json` file is now published for the permanent certificate; Android's device-side website association still needs physical confirmation. The web-only association file is intentionally absent from APK assets because Android's AAPT excludes dot directories.

## Verification performed

- TypeScript and scoped ESLint pass. Full unit/API suite: **237 tests in 48 files pass**. The final local-preview descriptor change was additionally rechecked with eight native/deferred transport tests.
- Full Go suite passes, including two new Android audio-security tests covering exact lease/session/socket binding, no microphone/subscription grant, audio opt-out, changed leases and voice departure.
- Android/Kotlin/Java compilation and release vital lint pass. Three meaningful native policy tests verify selected-share subscription, microphone/stale-buffer erasure and bounded portrait/landscape capture sizing. The pre-existing arithmetic scaffold also runs; instrumentation's wrong application-ID assertion was corrected, but instrumented tests have not run on a device.
- Headless touch Chrome at 390×844, using the candidate frontend, a simulated Capacitor bridge and a real isolated Go fixture, passes channel preview/join, participants, member sheet, bottom call controls, mute, local/remote renderer requests and ready-state handling, plus Persian RTL. **This does not prove decoded Android video or captured Android sound.** A zero-width renderer layout was caught and fixed before final packaging.
- Shared desktop/web regressions passed for frontend smoothness, chat switching, history, emojis/Persian and explicit decoded WebRTC viewing. A historical gaming test assumed audio settings were expanded and hardcoded version 0.5.1; it was corrected to open Advanced audio and read the current package version, then passed.
- Both final APKs pass independent signature/version checks, ZIP 16 KiB alignment and 64-bit ELF load alignment. Every packaged shared frontend file matches the tested build. New native renderer, audio-publisher, speech and notification classes/methods are present in DEX.
- Final Linux audio-security and transient-control tests pass. Live private production checks pass auxiliary sound grants/revocation, outsider and old-membership audio denial, complete Persian/English/mixed WAV delivery with progress, repeated-text reuse, one persistent worker and the existing CPU isolation. Forty heartbeat samples had no errors, with a maximum of 272 ms during this probe. These are bounded regression observations, not a sustained performance benchmark.
- Both public APKs and all promoted manifests were verified over HTTPS before committing the release. The unchanged Windows installer/dedicated manifest, legacy Electron manifest routing and domain association file were also checked. Deployment reports are `backend-deployment.json`, `production-speech.json`, `server-publication.json` and `public-verification.json` under the release evidence directory. The original APK source manifest is preserved; `publication-source-files.json` records the later backend retry correction separately.

Evidence is under `artifacts/android-1.1.1`: `candidate.json`, `source-files.json`, `apk-verification.json`, per-variant verification records/logs, Go/native/unit logs, and `ui/` screenshots/report. The source manifest records 375 files. Earlier superseded APK/logs are retained separately and must not be installed as the final candidate.

## Preliminary physical acceptance

After manual testing on Poco F3 / Android 13, the user reported "it worked perfectly so far" and authorized publication. This is preliminary acceptance, without individual measurements or a detailed result for each scenario. The requested checks were:

1. Install over the existing release and confirm retained account/settings.
2. Preview/join channels, see participants, open Members, and use the persistent call controls while navigating chat.
3. Start sharing and show/hide/reopen self-preview without stopping outgoing capture; confirm moving frames on an independent web/Windows receiver.
4. Watch independent Windows/web shares; use fullscreen/Back, stop/reopen, multiple shares and portrait/landscape changes.
5. Lock for two minutes in a call, resume, and stop sharing from the notification. Follow with longer background/Doze, Wi-Fi/mobile switching and headset/interruption tests.

After backend activation, the user answered "worked" to the specific Poco F3 test of sharing video/game playback sound alongside the microphone to a web/Windows listener. Phone playback sound plus microphone is therefore recorded as a user-reported physical pass on Android 13. Independent stream volume/mute/deafen, own-call exclusion, cancellation/system stop and repeated restart remain separate extended checks. Some apps prohibit playback capture. The new automatic updater staging/installation flow still needs a separate device result; no real Android updater success is claimed yet.

Publication is complete with preliminary user acceptance and a user-reported phone playback-sound/microphone pass. Closed-app push, the next-version Android updater install, sustained phone CPU/RAM/battery/thermal measurement and extended physical acceptance remain open. This device result does not establish that every Android app permits playback capture.
