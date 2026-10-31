# Dorham 1.0.1 web update

The web update is live at **https://dorhamapp.ir/**. The backend remains 1.0.0. Windows/Android stable downloads and their update manifest remain 1.0.0; native work is deferred at the operator's request.

## Screen sound and watching

With Share sound checked, the browser previously requested `systemAudio: exclude`, preventing Chrome from offering system audio for an entire-screen game share. It now requests `include` only when the user selects Share sound, retaining `restrictOwnAudio: true` and excluding the current browser surface. Without opt-in it requests no audio. The picker still requires the user's audio selection; choosing Entire Screen and enabling Share system audio supports game audio where Chrome/OS provide it. See [Chrome screen-sharing controls](https://developer.chrome.com/docs/web-platform/screen-sharing-controls).

Fullscreen now contains the video together with Dorham's actual stream volume/mute controls. Sound playback resumes on positive stream-volume and watching gestures. If the capture supplies no audio track, the viewer shows a clear no-sound message and the sharer is told to restart with audio enabled. Screen audio is separate from the microphone.

Live shares remain visible while Voice controls is collapsed. The Watch stream button is directly accessible without opening participant controls. English and Persian labels are included.

## Verification and rollout

- Lint, TypeScript and production web build pass; **161 unit/API tests in 31 files** pass.
- The isolated real-SFU two-client test receives decoded synthetic screen video/audio, including fullscreen stream volume/mute, half-volume amplitude, independent microphone mute, deafen/undeafen, closing/reopening, PTT and stopping/revoking a share. Watch stream is visible with voice controls collapsed. The synthetic whole-screen fixture returns sound only when system audio is requested. This verifies capture options and transported audio; physical game/system loopback and OS own-audio exclusion remain separate operator checks.
- A fresh online backup was downloaded and independently verified: 38 table digests, four stored data files and 59 prior web files, SQLite integrity and foreign keys. The backup remains private.
- The web-only rollout publishes 60 files, retains previous hashed assets for already-open clients and atomically replaces the entry page. The voice process PID/start time is unchanged. All four services remain active. No backend executable, database schema, runtime settings, Caddy settings, native installers or stable update manifest are changed. Public HTTPS payload/readiness verification is recorded separately.

Users should refresh the web page on both sides, stop the previous share and start again with Share sound plus audio enabled in Chrome's picker. Existing running JavaScript is not forcibly reloaded during calls.

## Deferred native preview work

The earlier 1.0.1 preview removes the native server-address field, fixes Android's pre-join `voice:state` request causing NOT_IN_VOICE, and allows listen-only joining without microphone permission or hardware. Its three adapter regressions use the real API with a mocked native bridge. Mesh and isolated SFU missing-microphone, permission-denied and unavailable-API receive-audio checks also pass.

The signed Android preview uses the same permanent key/package as 1.0.0, version 1.0.1 and build 1000001. Compilation, vital lint, v2 signature and 16 KiB alignment checks pass. Its signing certificate SHA-256 is `2ae98de4ee027368967ec635684a41aab5915c71f4084deda77119138a62383c`. Poco F3 / Android 13 installation, login retention and voice tests are explicitly deferred by the operator. The direct test APK is retained; the stable manifest does not advertise it.

The unsigned Windows preview keeps its existing stable app ID and installer identity. Packaged update-UI checks pass. These native previews were built before the later web screen-sound fix and are not asserted to contain the current web payload. Future native release work must rebuild from the intended source, reuse signing/installer identity, and avoid overwriting the published immutable test APK. The earlier full compiled server package in `/tmp` is staging only and was not deployed.

No new media-capacity, physical microphone quality or weak-device CPU certification is included.
