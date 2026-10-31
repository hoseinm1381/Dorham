# Dorham 1.0.2 web update

The web-only update is live at **https://dorhamapp.ir/**. It adds selected-window audio requests and clearer capture-picker instructions. Backend and stable Windows/Android downloads remain 1.0.0; native work is deferred.

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

The fresh private online backup was downloaded and independently verified: 38 database table digests, five stored files and all 78 previous web files, plus SQLite integrity and foreign keys. Its SHA-256 is `e158a1a6de33be5f3382020210549ff00c305746dfdea94abfe5b03681eb919e`.

The web-only rollout changed 19 files and verified all 60 new web files through both local HTTP and public HTTPS with normal DNS/TLS. Existing hashed assets are retained for open clients. All four services remain active. Live service PID/start identity, runtime/Caddy settings, native update manifest and backend package are unchanged. No services were restarted. Deployment and public payload evidence is included in the release artifacts.

Refresh the web page on both sharing and viewing computers, stop the old share and start a new one. Select Window or Chrome Tab and enable audio in Chrome's picker. Native preview builds and their deferred phone tests remain documented in [1.0.1](RELEASE-1.0.1.md).
