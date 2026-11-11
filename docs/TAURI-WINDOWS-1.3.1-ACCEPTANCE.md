# Dorham Desktop 1.3.1 Windows qualification

The public 1.2.8 installer has SHA-256 `d2b68cac2e234dc3e5d136e9a63fc7084cfbc892ca8c5811789a35ffd5a8f8d6`. The fixed 1.3.0 installer has SHA-256 `3d5e27457fdcda54b96eca06630255e7dddcbb76ffa1299e08cf292f21d2e741`. Its extracted executable has SHA-256 `32bd7aa3418226c69970b960a8532eb2f91605f3ef279e3b092124b49970d784`. The 1.3.0 development executable saved before editing has SHA-256 `6f100c913886e8a2282db35b2fceb576d288a55452f2c7df20b58321f0086d41`.

The operator confirmed that a disposable Windows 11 account or VM is unavailable. The supplied historical release benchmark temporarily moved the personal profile to run 1.3.0. Current qualification uses disposable directories. The packaged 1.3.1 executable accepts an explicit `--benchmark-profile` directory. This launch mode uses its own settings, WebView2 storage and migration input. Its updater skips installed-app updates. The historical fixed 1.3.0 release measured 39.3% sharing CPU and 279 MiB signed-in idle private memory in one trial. Public 1.2.8 measured 24.9% and 176 MiB in the paired trial. These historical figures serve as reference alongside the repeated development comparison. Full install-over tests and native Windows 10 testing remain pending.

## Performance changes

The supplied fixed 1.3.0 release samples attributed about 32.8% of one logical core to WebView2 processes during sharing, 4.5% to the host and 2.0% to the capture helpers, using the mean of the rounded process samples. The browser processed about 50 PCM requests per second. Its video receiver displayed around 10 frames per second. This led to batching up to three ordered 20 ms PCM packets per request and pacing requests at 32 ms, with a bound on outstanding batches. The shared video mapping and binary-response fallback remain available at the selected capture quality.

The older signed-in trace showed its largest immediate private-memory increase in WebView2's GPU process, followed by the renderer. In the comparable backdrop experiment, removing full-window dialog blur changed settled private memory by under 1 MiB. The first low-memory-target prototype lowered settled working set from 432–443 MiB to 367–382 MiB in the development samples. Private memory ranged from 219–222 MiB before and 218–226 MiB afterward. WebView2 returns to the normal target on user activity and whenever a call begins. The low target keeps scripts and connections running. [WebView2 memory usage target](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2_19)

An actual login click also opened the notification AudioContext in the older build. Blocking that allocation in one diagnostic pair moved sampled settled private memory from 222–237 MiB to 215–228 MiB. A subsequent regression trace found that signed-in pointer or keyboard input also opened the voice TTS context outside a call. The Windows Tauri renderer now opens the cue context for actual playback and closes it after six seconds of silence. It opens the TTS context when speech is queued and closes it when voice TTS stops. Qualification checks signed-in input, the first cue, and another cue after closure.

The first packaged overlay test found one foreground activation with the non-activating style already set. The replacement calls the Windows show operation with `SWP_NOACTIVATE`. The fixture checks the actual foreground window, click-through styles, participant state, rapid toggles, and the owned-window lock message path.

Benchmark inputs, raw results and product logs are under `artifacts/v1.3.1/qualification`.

## Matched Windows 11 measurements

The small-window benchmark used two trials per build, alternating the build order. All three used the same Windows 11 PC, local Go fixture backend, owned animated application, Balanced preset, application audio scope, two-peer Mesh receiver and process sampling script. The selected window handle was checked before sharing. CPU is reported as a percentage of one logical core across the Dorham process tree. Private memory measures private committed bytes. Working set measures resident bytes summed across processes and can count shared pages in more than one process. The table shows trial medians and ranges. Startup runs from process launch until the sign-in heading is ready. First voice measures the time from the join action to the ready voice UI. The cooldown was sampled once per build.

| Small workload | Public 1.2.8 release | Fixed 1.3.0 development | 1.3.1 extracted release |
|---|---:|---:|---:|
| Startup, ms | 413 (398–428) | 617 (610–623) | 783 (579–987) |
| Signed-out private, fresh / settled, MiB | 225 (223–227) / 207 (206–209) | 235 (231–239) / 211 (208–215) | 230 (230–230) / 206 (205–206) |
| Signed-out working set, fresh / settled, MiB | 395 (393–397) / 380 (378–382) | 432 (428–436) / 413 (410–416) | 420 (419–421) / 323 (322–323) |
| Signed-in private, fresh / settled, MiB | 265 (251–280) / 220 (215–224) | 309 (298–320) / 241 (221–262) | 288 (287–289) / 233 (224–241) |
| Signed-in working set, fresh / settled, MiB | 519 (505–534) / 477 (472–482) | 529 (519–539) / 472 (453–492) | 456 (451–461) / 79 (56–102) |
| First voice, ms | 122 (113–132) | 80 (53–107) | 201 (195–207) |
| Two-peer listen-only voice private, MiB | 319 (318–320) | 291 (290–292) | 287 (285–289) |
| Overlay enabled, working set, MiB | 752 (752–753) | 577 (572–581) | 368 (366–370) |
| Sharing CPU, % of one logical core | 14.6 (14.3–14.8) | 29.0 (26.1–31.8) | 27.1 (26.3–27.9) |
| Sharing private, MiB | 450 (441–460) | 428 (428–428) | 417 (415–419) |
| Private after stop / 30 s cooldown, MiB | 359 (354–363) / 321 | 321 (317–325) / 276 | 318 (318–318) / 275 |
| Decoded dimensions | 502 × 314 | 502 × 315 | 502 × 315 |
| Decoded FPS | 10.6 (10.5–10.6) | 10.6 (10.6–10.7) | 10.6 (10.6–10.7) |
| Video bitrate, kbps | 71.5 (70.5–72.5) | 61.1 (60.0–62.2) | 58.1 (54.7–61.5) |
| Audio bitrate, kbps | 48.4 (48.3–48.5) | 48.4 (48.4–48.4) | 48.4 (48.3–48.5) |

The six receiver samples had zero dropped frames and detected the selected application's tone in all 64 audio probe windows per trial. 1.3.1 had lower fresh signed-in private memory in both comparisons with fixed 1.3.0 development. The settled private ranges overlap and Electron used less private memory in both settled samples. The working-set drop after WebView2's low-memory target applied was larger. First voice was slower in this small full-lifecycle benchmark. Startup included one slower 1.3.1 run.

WebView2's browser process used 6.1–6.6% CPU in 1.3.1 versus 8.7–9.2% in fixed 1.3.0 development. The Dorham host used 2.6–3.3% versus 3.5–3.8%. The video and audio helpers each stayed below 1.2% and 1.5%, respectively, on the small workload. WebView2 renderer usage varied from 10.5% to 16.1% in 1.3.1 and from 8.8% to 14.5% in fixed 1.3.0 development. PCM fetch counts fell from 373–376 to 231–243 during the measured share lifetimes. Those lifetimes differ by under one second in the two pairs. The 1.3.1 samples received more PCM bytes per share.

The shorter small-window samples overlapped. The follow-up alternated the two Tauri builds with ten process samples per stage and about 14–15 seconds of active measurement per trial. CPU fell from 35.5% (35.2–35.8%) on fixed 1.3.0 development to 30.9% (29.0–32.7%) on 1.3.1 extracted release. Active private memory fell from 402.7 MiB (400.0–405.4) to 394.1 MiB (392.0–396.2). Both decoded 502 × 315 at 10.4 fps median, had zero dropped frames, sent 48.4 kbps audio, and had signal in all 64 audio probe windows per trial. Video bitrate moved from 57.5 kbps (55.2–59.7) to 59.6 kbps (59.0–60.2). PCM requests fell from 830–842 to 501–519. First voice was 148 ms (116–181) and 132 ms (119–145), respectively. Taken with the full-lifecycle trials, these samples show sensitivity to the prior idle and startup sequence.

The larger animated window decoded at 1216 × 720 in every trial. The second run reversed the build order. CPU was lower for 1.3.1 in one pair and higher in the reverse-order pair. Electron ran at a higher frame rate and bitrate and used less CPU.

| Larger workload | Public 1.2.8 release | Fixed 1.3.0 development | 1.3.1 extracted release |
|---|---:|---:|---:|
| Sharing CPU, % of one logical core | 20.9 (20.6–21.2) | 35.7 (31.0–40.4) | 33.1 (32.4–33.7) |
| Sharing private, MiB | 515 (509–522) | 468 (455–480) | 479 (469–489) |
| Decoded FPS | 14.9 (14.9–14.9) | 10.6 (10.4–10.8) | 10.6 (10.5–10.7) |
| Video bitrate, kbps | 582.6 (564.0–601.2) | 302.3 (281.2–323.4) | 287.7 (284.1–291.2) |

All six larger-window trials had zero dropped frames, 48.3–48.5 kbps audio and signal in all 64 audio probe windows per trial.

In a separate three-cycle 1.3.1 release run, private memory was 335 MiB in two-peer voice before sharing, 436–444 MiB during the three shares, and 342, 331 and 335 MiB after the respective stops. At 30 seconds after the third stop it was 301 MiB. The process samples showed both capture helpers during each share and neither after any stop. The receiver detected audio in all 64 probe windows in each cycle. It recorded one dropped frame in the third cycle and zero in the first two.

An instrumented native helper captured 52 frames per workload. Small-window cumulative wait and work measured 0.1 ms in frame acquisition, 44.6 ms in GPU copy and readback, 17.3 ms packing and 38.5 ms writing to the pipe. The larger workload measured 0.3 ms, 109.1 ms, 109.3 ms and 164.0 ms respectively. These elapsed times can include blocking and are from a diagnostic copy of the video helper. The production helper remained in the packaged benchmark. The renderer trace for the larger workload measured 35.7–40.9 ms constructing 81–83 `VideoFrame` objects in one paired run. Receiver and outbound WebRTC statistics, request counts and timings, and CPU/RAM samples by process role are in the raw logs.

## Package and runtime checks

The local unsigned installer is `artifacts/v1.3.1/windows/Dorham-1.3.1-Windows-x64.exe`. It is 12,195,861 bytes and its SHA-256 is `f816defc4470698b4ff5c6dabe6b4f8c43667ed13ff4d73d05c2ba7bf9dd2be2`. The extracted x64 executable has SHA-256 `243fa2212a4f395e375419aa4ee708ba2db0ffe77fe0b49d26130046f79eb390`. All packaged payload files match the build inventory. Source revision is `feb7c6971beb3ce7040a1a18e728a041147243ac`. The staged Windows manifest matches the installer byte count and hash and includes the existing Android 1.2.8 manifest in the local release catalog.

The exact 1.3.1 executable reported its version to the Windows feature endpoint and passed the native overlay and notification preview regression. A queued TTS clip played and its audio context closed on leaving voice. The exact executable decoded the selected application's audio and video on a second client through two cycles on both Mesh and LiveKit, including picker cancellation, stop, restart, source closure and helper exit. The native scope test checked three independent tones and confirmed application-only capture and system capture excluding Dorham playback. The binary-response fallback delivered video and stopped on source closure on Windows 11. The full native Windows 10 path remains pending.

The two-peer listen-only call stayed connected while the exact 1.3.1 app's main window was hidden to the tray and restored. The process tree sampled 0.8% CPU, 280 MiB private and 517 MiB working set while hidden. Live device switching, background push-to-talk and network reconnect still need dedicated native runtime checks.

The production NSIS migration macro and exact release validator migrated a profile created by public Electron 1.2.8. The exact 1.3.1 runtime opened the same account and retained the draft, Persian language, hotkey and overlay settings after restart. It also reopened a profile created by the fixed 1.3.0 development executable and retained the same account, draft and overlay setting. These exercises used the runtime and the migration macro with disposable profiles. They leave the full NSIS install-over and single uninstall entry checks pending.

TypeScript and ESLint passed. All 257 JavaScript tests and five Rust tests passed under the regular Windows test account.

## Release decision

Hold the final hands-on approval request. The current comparison establishes the sustained small-window CPU saving against fixed 1.3.0 development. The larger workload CPU ranges overlap. The matched run against the exact fixed 1.3.0 release and the full installer upgrades from both prior releases require a disposable Windows environment. Windows 10 runtime validation is pending. The installer and download metadata are staged locally.
