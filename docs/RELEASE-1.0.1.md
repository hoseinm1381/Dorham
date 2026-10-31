# Dorham 1.0.1 voice joining fix

Windows and signed Android release packages are built. The direct Android test download is published; the stable update manifest remains on 1.0.0 until phone testing and final deployment finish.

The server address input is removed from native sign-in and registration. Native apps use their configured Dorham connection automatically, including guest access and password recovery.

## Android join failure

The native adapter previously sent `voice:state` while the lazy transport was still preparing, before `voice:join`. The server correctly rejected this with `NOT_IN_VOICE` / “Voice session is no longer active.” This prevented Android from reaching the microphone permission prompt. The fix stores mute/deafen locally until membership and native connection exist, passes the intended initial state into native joining, and renews membership while a slow SFU connection completes. The regression tests use the real API with a mocked native bridge; they reproduce the protocol ordering, without claiming a physical Android media test.

Microphone denial or absence now allows a listen-only connection on Android, Windows and web. Capture failure does not discard a healthy receiving connection. The server sees the participant as muted while receiving stays enabled. The interface shows “Listening only” and disables the unavailable microphone control; leaving and rejoining retries permission/device access. Deafen and screen watching remain available. Mesh connections create a receive-only audio transceiver when no track exists.

The Android foreground service starts with media playback and adds the microphone type only when capture is permitted; screen projection is tracked independently. Notifications are optional for joining. Microphone hardware is declared optional. This follows the separate foreground-service permissions described in [Android documentation](https://developer.android.com/develop/background-work/services/fgs/service-types). App-initiated service shutdown is distinguished from system shutdown during rejoin.

## Verification

- Lint, TypeScript and production builds pass. All **159 unit/API tests in 31 files** pass, including three real-control-plane Android adapter regression tests.
- Two-client Chrome checks pass on both mesh and the existing live SFU in isolated temporary rooms. Missing hardware (`NotFoundError`), denied permission (`NotAllowedError`) and absent microphone API all receive decoded synthetic audio. Heartbeats, deafen/undeafen, leave/rejoin and avoiding repeated permission requests pass. No production test accounts or rooms are used.
- Packaged Windows checks confirm 1.0.1, hidden server address, future-version notice, no equal-version notice and native installer dispatch with an isolated profile. That dispatch test substitutes the installer action; it does not execute an installer. The stable Windows app ID/NSIS identity and installation-directory policy are unchanged from the real 0.7.6-to-1.0.0 upgrade test. No new real Windows installation is claimed for this patch.
- All **60 web files and six Windows shell/contract files** match the packaged ASAR. The APK contains the same 60 web files. Android Gradle release compilation and vital lint pass. APK Signature Scheme v2 verifies, the certificate matches 1.0.0, ZIP alignment passes 16 KiB, and all six aligned arm64/x86_64 native libraries match 1.0.0 byte for byte.
- Android package ID remains `com.dorham.chat`, version **1.0.1**, build **1000001**. The permanent signing certificate SHA-256 remains `2ae98de4ee027368967ec635684a41aab5915c71f4084deda77119138a62383c`. Windows remains unsigned by the operator's choice.

Physical test requested: install over 1.0.0 on the operator's Poco F3 / Android 13, retain login, join with microphone permission, exchange voice, then deny permission and verify listening. This result is pending.

No database schema or server runtime dependency changes. New media-capacity and weak-device CPU acceptance are outside this patch.
