# Windows 1.4.8 audio sharing

Normal Windows 10 releases use builds below 20348. Previously the native host
returned `sharedAudio: false` on these builds, which disabled the Share sound
checkbox. The helper used process loopback exclusively.

Microsoft documents process loopback's minimum build as 20348
<https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/>.
Endpoint WASAPI loopback works on older Windows
<https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording>.

The Windows host now enables shared audio on the same supported builds as
native video capture (18362 and above), when both helpers are installed.
Below 20348, the picker offers default-output sound and disables application-only
sound. It starts with No sound and explains that output capture includes other
apps, notifications and Dorham voices. Selecting another video source does not
automatically enable audio. Application-only grants are rejected on old builds
in both the picker handler and the helper argument builder. There is no automatic
fallback from an application grant to all output sound.

On newer builds, application capture and computer sound excluding Dorham keep
using process loopback. Backend, Web and Android versions remain 1.4.7.

The new `output-system` helper mode opens the default eConsole render endpoint,
requests 48 kHz stereo float PCM with automatic format conversion, and uses the
existing bounded pipe/worklet path. It stops on parent exit, stdin closure or
explicit host teardown. Changing output devices during capture may require
restarting sharing. Protected content and exclusive-mode playback may be absent.
Users who want to avoid returning call audio on Windows 10 should route Dorham
call playback to a different output device before sharing computer sound.

Verification evidence is in `.tools/windows-audio-148/`. A generated 400 Hz tone
was captured by the actual endpoint-loopback helper and stdin closure stopped
it cleanly. Rust tests cover old/new Windows scope selection, rejecting unsupported
application capture and preserving bounded FIFO audio batches. The native app
integration test exercises the picker script with simulated Windows 10
capabilities and measures newer Windows application/system audio isolation.

A physical Windows 10 end-to-end test remains required for Windows 10 runtime
certification. The available host runs newer Windows; simulation and running the
older API there do not establish driver-specific Windows 10 compatibility.

Candidate installer
`artifacts/v1.4.8/windows/Dorham-1.4.8-Windows-x64.exe`

SHA-256
`a3091ac7abb837d67aa18d0c7449244b9bc896641afecb7c8d65c133d2e70e6e`

Published to the Windows production download feed on 2026-11-18 at
05:53:45 UTC. Public installer SHA-256, byte-range resume and both Windows
update feed routes were verified. All 784 web files and the Android APK were
verified unchanged. Web, Android and backend remain 1.4.7; no restart occurred.
The receipt is `.tools/windows-audio-148/publish-receipt.log`.
