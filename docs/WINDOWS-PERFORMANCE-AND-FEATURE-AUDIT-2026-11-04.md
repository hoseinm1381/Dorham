# Windows performance, screen sharing and updates

**Implemented and released in 1.1.1:** all four priorities now have native
implementation/runtime evidence, including screen/audio and real NSIS update
tests. See [the release record](RELEASE-1.1.1.md). Status statements in the
preserved audit below are historical.

Reviewed 4 November 2026 against the shipped Electron architecture and the
current workspace. Windows package metadata remains 1.1.0. The Rust/WebView2
migration remains paused. Web 1.1.1 is prepared separately and is not published.

## Main finding

Windows retains the shared React UI, but its native capture adapter removes
features available through Chrome's picker. Sound is explicitly disabled;
the source chooser is a paginated text dialog. These are feature gaps, not
evidence that a faster backend or a different UI framework is required.

The requested automatic updater is now implemented locally in the existing
Electron/NSIS path. Screen/audio changes below are recommendations, not
implemented or certified capture fixes.

## Recommended order

| Priority | Work | Evidence and expected result |
| --- | --- | --- |
| 1 | Restore safe screen audio | Both host and preload set `systemAudioSafe=false`. LiveKit checks that flag; mesh independently has no screen-audio path. Add tested audio capture and clear source scope before enabling the feature. |
| 2 | Replace the source chooser | `desktopCapturer.getSources` requests zero-size thumbnails, then a message box lists ten names per page. Use a searchable preview grid with Screens/Applications tabs, audio scope, cancel and selection validation. |
| 3 | Include the prepared shared frontend improvements in the next native package | Native builds copy `apps/web/dist`; updating the website cannot update the installed app's bundled UI. The tested composer/history/memoization changes should reduce renderer work, but require a matched native measurement before claiming Windows speedups. |
| 4 | Reduce overlay and hidden-call UI work | Overlay polling runs every 100 ms; changed state triggers synchronous settings reads, bounds changes and full DOM row replacement. Cache preferences, send changed state, keep avatar data stable, patch rows and only reposition when layout changes. |
| 5 | Automatic downloads and restart-to-update | Implemented locally and tested as described below. Package and real upgrade acceptance remain pending. |

## Why sound sharing is unavailable

- `apps/desktop/main.cjs` explicitly disables loopback and omits audio from the
  capture callback. The comment requires an installed own-audio-exclusion test.
- `apps/desktop/preload.cjs` also exposes `systemAudioSafe:false`.
- `packages/media/src/livekit.ts` consequently advertises no shared audio on
  Windows. It already supports publishing captured audio as ScreenShareAudio,
  per-stream volume and watched-only subscriptions when capability is enabled.
- `packages/media/src/mesh.ts` always advertises `sharedAudio:false`, requests
  `audio:false`, and creates a video-only share. Native capture alone cannot
  add mesh audio; that requires signaling, track handling and playback work.
- Web capture uses `windowAudio:'window'` and `restrictOwnAudio:true`. Those
  request fields do not prove that Electron's native capture callback enforces
  the same selected-application and own-audio-exclusion behavior.

Electron 45.1.0 documents native `loopback` as system audio. It does not expose
an arbitrary selected application's audio through that callback. The native
system-picker option is documented for macOS, so enabling that flag is not a
Windows Chrome-picker replacement. See the [versioned Electron session API](https://github.com/electron/electron/blob/v45.1.0/docs/api/session.md).

A suitable implementation should distinguish:

1. **Application sound:** capture the selected process tree and exclude other
   applications. Resolve the selected window to its process in the native host.
2. **Computer sound:** capture system sound while excluding Dorham's received
   call audio and notification sounds. Clearly label this broader scope.

Microsoft provides a process-loopback API/sample supporting inclusion or
exclusion of a process tree from Windows build 20348 onward. This is a feasible
native-helper direction, not an implemented Dorham feature or a guarantee for
every Windows 10 installation. Older systems need an explicit unsupported state
or separately validated fallback. See [Microsoft's application loopback sample](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/).

First spike: test Electron's actual captured track settings and output using
the bundled runtime; retain its simpler path only if exclusion and source scope
are proved. If it fails, use the process-loopback helper, with bounded audio
queues and a dedicated shared-audio track. Do not route game sound through the
microphone's gain, suppression or push-to-talk graph.

Required acceptance: play distinct owned tones from the selected application,
another application and Dorham's received-call path. On a second client verify
which tones decode, independent stream volume, deafen, mute semantics,
headphone/output changes, no feedback, and complete cleanup on stop/restart,
cancel, lock, disconnect and permission removal. Cover the actual SFU path;
extend mesh separately or accurately keep its audio capability disabled.

## Capture experience and quality

The preview chooser should be an isolated, sandboxed window with narrowly scoped
IPC and one outstanding capture request. Return only a selected source identifier
to the trusted main frame; reject stale/closed sources and close the request on
navigation or cancellation. Generate bounded thumbnails while the chooser is
open; stop enumeration/refresh when it closes. Application icons and a stable
selection are preferable to continuously moving sources.

Show the chosen source and actual audio status during sharing. Add Change source
without leaving the call, with lease/track cleanup and no accidentally shared
old source. Platform-specific explanations must replace the current Chrome-only
picker instructions if Windows audio becomes available.

480p/720p, 15/30 fps and a maximum 1.5 Mbps budget are shared product limits,
not uniquely Windows defects. Initial capture constraints are mostly ideal
values; inspect actual capture dimensions/frame rates and encoder statistics
before reducing oversized capture work. Evaluate text/detail versus motion
content hints and GPU encode/decode behavior with real games. A 1080p/60 option
needs transport/policy/load validation, not just another dropdown entry.

## Windows performance work

The existing watched-only SFU subscriptions and adaptive-stream/dynacast options
are useful and should be preserved. The main performance opportunities are:

- Include web 1.1.1's shared UI work in the native build, preserving the matching
  production assets. HTTP compression from that web release does not reduce the
  installed app's local file reads or its renderer CPU.
- Cache native settings, remove sync file reads from frequent overlay updates,
  stop the 100 ms poll when inactive/disabled, update only changed rows, and avoid
  repeating PNG/avatar payloads on speaking changes.
- Active calls deliberately disable renderer background throttling. Suppress
  hidden chat/animation/layout work while retaining voice, signaling, hotkeys
  and the small overlay. Do not globally re-enable throttling without background
  audio/PTT/sleep-resume tests.
- Profile idle, typing/long-history scroll, active voice, minimized voice,
  overlay on/off, screen publishing and watching under matching conditions.
  Record the entire process tree's CPU/working set, long tasks, decoded frames,
  freezes, dropped frames and sent bitrate. Compare the same backend, clients,
  source, bandwidth and duration. This audit makes no new FPS/RAM speedup claim.

[Electron's performance guidance](https://www.electronjs.org/docs/latest/tutorial/performance)
supports profiling actual bottlenecks and avoiding blocking main-process I/O.

## Automatic updater implemented locally

Changes are confined to `apps/desktop/main.cjs`, `apps/desktop/updater.cjs` and
two Windows test files. No frontend bundle, dependency, app version, installer,
manifest, backend, website or personal installation was changed for this work.

- Packaged Windows builds check automatically at startup and hourly, with
  throttled focus/resume checks. Existing in-app checks/update actions continue.
- A newer installer downloads automatically to the app's own update cache.
  Downloads are skipped during calls and interrupted if a call starts; they
  retry afterward. An interrupted download restarts rather than resuming bytes.
- English/Persian tray menus show progress and **Restart to update**. The
  existing in-app Update action reuses the staged installer. Installation is
  explicit; startup does not forcibly install or restart the app.
- The downloader keeps the exact trusted release origin/path, version/app ID,
  size bounds, no redirects and SHA-256 checks. Manifest reads are bounded while
  streaming. Cached files are rehashed after app restart and before execution.
- Concurrent checks/downloads coalesce, partial files are removed, staged
  payloads are reused, and duplicate installer launches are blocked.
- Both the UI IPC and final launch check reject installation during a call.
  A failed launch keeps the app open and permits retry. The existing per-user
  NSIS installer is invoked with `/S --updated --force-run` to update and reopen
  in place; the NSIS template supports these flags.

The existing custom manifest remains compatible, so no feed switch or new
runtime updater dependency is required. Windows NSIS is also supported by
[electron-updater](https://www.electron.build/v26/docs/features/auto-update/),
but changing to its feed format would require a separate migration. The current
package is unsigned: HTTPS plus a hash from the same trusted feed detects corrupt
downloads but is not independent publisher-signature authentication. Signed
release metadata and Windows code signing are future hardening options.

## Other feature gaps

Source inspection also finds no startup-with-Windows option or native message
notification integration. Closing the window outside a call exits the app;
minimize-to-tray outside calls would be a useful explicit preference. The voice
overlay is primary-display only and does not support exclusive-fullscreen games.
These follow screen/audio parity; the current microphone/device/gain/hotkey
features should be regression-tested rather than described as missing.

## Verification and release boundaries

Updater/manifest/frame-security tests and isolated main-process integration
tests cover automatic staging, progress/cache reuse, payload corruption and
tampering, call cancellation/retry, offline checks, duplicate launches, timer
lifecycle, trusted IPC and Persian tray labels. All **227 tests in 46 files**,
TypeScript and targeted ESLint pass. Logs are under
`artifacts/windows-audit-2026-11-04`.

A real Electron 45.1.0 smoke test loads the actual main/preload/updater, routes
the strict feed to a loopback-only fixture, and blocks external requests. It
passes real Electron net streaming, call download/install guards, automatic
staging after call end, and English/Persian native tray controls. Installer
spawning is stubbed: no installer is executed. Combined browser/Electron working
set sampled 1653.2 MiB, below the 4096 MiB budget / 3500 MiB stop threshold. This
is a safety measurement, not a Windows before/after performance comparison.

Earlier smoke attempts and diagnostics are retained. The first tool-sandbox
attempt failed on Electron's AppContainer ACL check; the successful run used
normal sandboxed Electron outside the tool sandbox without ACL changes or
`--no-sandbox`. Fixture timing/language polling issues were corrected separately.

No new screen-audio implementation, physical audio proof, native performance
comparison, packaged updater or actual silent in-place upgrade is certified.
Before publication, choose the next Windows version, build frozen source,
validate a real isolated old-to-new silent upgrade/relaunch with login,
credentials, drafts and preferences retained, and verify installer hashes and
the public feed. Existing 1.1.0 users need to take that first release through
their current Update action before receiving the new automatic-download behavior.
Server publication remains deferred by the operator.
