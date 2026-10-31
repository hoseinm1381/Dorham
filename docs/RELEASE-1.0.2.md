# Dorham 1.0.2 web update

This web-only update adds selected-window audio requests and clearer capture-picker instructions. Backend and stable Windows/Android downloads remain 1.0.0; native work is deferred.

## Sharing sound

Select Share screen, enable Share sound, and enable audio in Chrome's own picker too. For Window, Dorham requests the selected application's sound using `windowAudio: window`. For a browser game, Chrome Tab shares just that tab. Entire Screen shares computer sound with Chrome's Share system audio switch enabled. The operator confirmed entire-screen sound works after enabling that switch.

LiveKit JS 2.23.0 drops the windowAudio hint when building capture options. Dorham now calls the native getDisplayMedia API directly and publishes its real video/audio tracks through LiveKit, retaining screen leases, bandwidth ceilings, own-audio restriction, explicit sound opt-in, and cancellation cleanup. No audio track means a clear restart/picker notice and a video-only publication. Chrome controls source/audio availability; Dorham cannot enable a disabled or absent native picker option. A selected-window request does not silently fall back to requesting all system audio for that window. See [Chrome windowAudio options](https://developer.chrome.com/release-notes/141).

Watch stream remains visible with voice controls collapsed. Fullscreen contains the stream sound slider and mute control added in 1.0.1.

## Verification

- Lint, TypeScript, production web build and 163 unit/API tests in 31 files pass. Tests cover direct picker options, opt-out, separate publication sources, encoder budgets, publication failure cleanup and late picker cancellation.
- Chrome 156.0.8078.79 on Windows 11 captured only an owned temporary WinForms window playing a generated 997 Hz tone. Native getDisplayMedia returned a window video track plus live 48 kHz stereo audio; measured RMS was 0.01874. No fake capture devices were used for this probe.
- A second test used that real selected-window capture through isolated SFU rooms: a receiving client decoded video and audio, controlled half-volume/mute, deafen, close/rewatch, independent microphone mute, PTT and share termination. The separate synthetic screen-capture regression also passes. Test accounts/database were local and removed; temporary remote rooms were deleted.
- Browser tests stayed within the existing 4 GiB combined browser budget. Neither this tone test nor two contexts on one workstation certifies every game/window implementation, multi-device physical feedback exclusion, or media capacity.

## Rollout

Prepared for web-only deployment following independent verification of a fresh online database/file/config/frontend rollback backup. Existing hashed assets are retained for open clients. Live service PID/start identity, runtime/Caddy settings, native update manifest and backend package remain unchanged. Final public payload and rollout evidence is recorded with the release artifacts.

Refresh the web page on both sharing and viewing computers, stop the old share and start a new one. Select Window or Chrome Tab and enable audio in Chrome's picker. Native preview builds and their deferred phone tests remain documented in [1.0.1](RELEASE-1.0.1.md).
