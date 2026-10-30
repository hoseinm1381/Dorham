# Microphone noise suppression and echo cancellation

Chrome/Electron mesh already requested echo cancellation, noise suppression and automatic gain control by default. The Android plugin also requests native hardware/software audio processing. The operator confirmed the follow-up voice/screen call worked after the external relay was configured.

Web and Windows now expose **Voice & connection → Microphone processing** with noise suppression and echo cancellation enabled by default. Preferences are stored on that device/browser and restored after reload. Controls show the active microphone's reported on/off settings; unsupported controls are disabled and missing applied-setting reports are stated explicitly.

Changes are saved for the next voice join. While the microphone is active, a pending notice says to leave/rejoin; the current capture and mute state remain intact. Microphone device selection keeps the current call's processing settings until rejoin. Starting a new call applies the saved preferences. This avoids relying on browsers silently accepting audio constraints without reconfiguring their active capture pipeline. Browser LiveKit capture uses the same explicit defaults and preferences; external SFU operation remains untested. Android continues using its automatic native processing and does not expose these browser toggles.

The implementation uses platform audio processing, with no extra model download, third-party audio-processing service, paid feature or additional machine-learning worker. Effectiveness depends on the browser, operating system and microphone; browser-reported settings do not quantify acoustic noise/echo reduction in decibels.

## Verification

`node scripts/browser-tests.mjs --grep 'microphone processing'` uses one Chrome context, an isolated real backend/database, real `getUserMedia` capture with the browser's synthetic input device, and actual track `getSettings()` values. It verifies both defaults on, queued changes preserving the same active track, persistence across reload, both off on the new capture, both on after another join, and mute preservation. Evidence: `artifacts/evidence/audio-processing.json`, `audio-processing-controls.png` and `audio-processing-memory.json`. Physical noise/echo attenuation is not measured by this fixture.

The public relay scenario additionally checks default capture settings and visible controls while two real WebRTC clients exchange decoded audio and screen video. See [relay verification](EXPRESSTURN.md) for its separate evidence/limits. Browser tests remain under the 4 GiB guard; a memory-limited run is not a pass. The guard now also terminates its fixture backend when it must stop the test tree.

Current results: focused capture test passed (13.1 seconds including setup, 2284.5 MiB peak combined browser usage). The newly installed Windows application and Chrome passed through the real public backend/relay (32.8 seconds including setup, 3144.1 MiB combined Chrome/Edge plus owned Dorham usage); both microphones reported noise suppression and echo cancellation true, and decoded audio/two screen streams passed. Neither successful run triggered the guard. A broader earlier run hit its early memory threshold and was not counted as passed.

References: [W3C capture constraints and settings](https://w3c.github.io/mediacapture-main/), [LiveKit AudioCaptureOptions](https://docs.livekit.io/reference/client-sdk-js/interfaces/AudioCaptureOptions.html).
