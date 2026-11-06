# Dorham 1.1.1 — published web and Windows

Published on 4 November 2026 at `https://dorhamapp.ir`. Android was subsequently published as 1.1.1 after preliminary Poco F3 acceptance; see its separate [release verification](RELEASE-1.1.1-ANDROID.md).
The Go backend retains its 1.1.0 base identity with the new tested speech revision.

## Features

- Windows preview/search source picker in English/Persian, with selected-application
  sound, computer sound excluding Dorham, and video-only modes. Application scope
  covers its process tree, rather than one tab within a browser. Sound requires
  Windows build 20348 or newer; older builds retain video-only sharing.
- Independent stream sound volume/mute and deafen, with viewer/share cleanup.
- Overlay settings/state caching and retained participant rows/images. Hidden
  muted previews pause/resume while voice and outgoing sharing continue.
- Shared frontend rendering/history improvements and public gzip/zstd/cache rules.
- Automatic Windows update discovery/staging outside calls, with **Restart to
  update** in the tray. Installation is blocked during voice. Existing 1.1.0 users
  first update to 1.1.1 to receive this automatic staging behavior.
- TTS prepares **one complete WAV before playback**, with a tiny percentage bar
  beside its text that disappears when ready. Arbitrary midpoint splitting is
  removed. Progress follows completed natural-sentence/phoneme work; one long
  inference can hold the percentage. The three-second minimum buffering remains.

The retained worker, pressure eviction/recovery, exact-text reuse and optimized
models remain enabled. Amir, the 30% speech CPU cap and 1 GiB memory limit are
preserved. Audio/progress remain private to eligible voice membership epochs.

## Verification

TypeScript, scoped lint, 235 unit/API tests and the Go suite pass. The paused Rust
migration is excluded from release lint. Ten Chrome regressions pass in bounded
batches, covering history anchors, decoded speaking/mute, retries/drafts,
composer navigation, emojis, Persian fonts/RTL and uploaded-file formatting.

Actual native capture and second-client decoding pass for all three sound modes.
Source mesh-to-Chrome and packaged SFU-to-independent-Chrome pass. Packaged mesh
passes with an independent web origin in a second sandboxed Electron renderer;
separate-Chrome attempts hit the unchanged memory guard. Hidden preview pause/
resume, continued voice/publishing, stream mute, deafen and restart/cleanup pass.
Owned animated windows/tones were used; no physical microphone was recorded.

For 100 speaking updates/16 participants, the matched overlay run reduced row/
image additions from 1600 to zero, hot settings reads from 200 to zero, and IPC
from 349100 to 173700 bytes. This is not a game-FPS/whole-app RAM certification.
Earlier frontend measurements remain in `artifacts/v1.1.1/matched`.

The real published 1.1.0 → final 1.1.1 installer retained login/settings. Final
1.1.1 automatically discovered/downloaded a private 1.1.2 fixture, verified its
installer, ran NSIS and relaunched with login, encrypted credentials, preferences
and local storage retained. A test-only clock advance exercises the native resume
throttle. The private future package adds diagnostic readout and is never published.
Personal file hashes and restored registry/shortcuts pass independent verification.
A wrapper postcheck initially miscounted a pre-existing legacy uninstall entry;
the stable app GUID remains unique and that older entry was preserved.

Whole-message speech passes browser PCM/progress, genuine local Piper, isolated
Linux and live tests. Representative live complete-readiness samples: Persian
10.00 s, English 6.88 s, mixed 10.51 s, reused Persian 3.48 s. Reuse returns identical
audio with zero synthesis CPU. These are not latency bounds; cold recovery can
still take roughly fifty seconds. Privacy, membership revocation, heartbeats and
ownership-checked removal of temporary production test data pass.

All 136 public web files match the tested output. Actual Caddy 2.6.2 validates
and gracefully reloads the candidate. Public gzip/zstd decode to the exact script
hash: 711891 bytes raw, 223871 gzip, 225735 zstd (about 69% fewer transfer bytes).
Public installer download/hash, HTTPS readiness and TLS WebSocket handshake pass.
Authenticated private speech sockets were tested separately.

Only Dorham restarted for the backend revision. Client publication preserved
service PIDs/limits, backend/config bytes, old hashed assets and database integrity.
Android and ordinary legacy latest.json bytes are unchanged. Legacy Windows
requests retain their platform-specific routing. No new media capacity or
every-game/physical-speaker certification is implied.

## Artifacts and rollback

- Windows: `artifacts/v1.1.1/windows/Dorham-1.1.1-Windows-x64.exe`, 122329401 bytes.
  SHA256 `5503b0f976314d342224c31255fe14a93a14df36831775548821245a722445d1`.
  Unsigned; all 158 ASAR/helper entries match frozen source/generated output.
- Web: `artifacts/v1.1.1/combined-release/Dorham-1.1.1-Web.zip`, 136 verified files.
  SHA256 `c4c5a60bc3172d496554f561b1cc5377311ab83dcf20310b74e33b126cef9783`.
- Linux binary SHA256:
  `4e790e18e64af6691bae2a1cec806d36d9e5ff9c323bf8f19f4b9ccd5ad3d061`.
- Worker SHA256:
  `4120aa581cafc7444fc4b247402bfbf7c05f675d6ecf2fbc8c527b0940dc1c63`.

Web/Caddy/catalog backup: `/var/lib/dorham-ops/backups/web-1.1.1-before`, with
335 downloaded archive entries independently verified. Backend rollback:
`/var/lib/dorham-ops/backups/fullspeech-before-3b2f5b8aa217`, with a checked
on-server SQLite backup. The first live probe raced cgroup creation; synchronous
rollback/cleanup was verified before the successful retry. No rollback timer was
introduced by this release.

Evidence: `artifacts/windows-1.1.1`, especially `real-update-summary.json`,
`package-verification-final.json`, backend reports, `client-publication-final.json`
and `public-verification-final.json`. Earlier artifacts are retained. Editable
sources stay in the existing workspace. Private credentials, full Caddy config,
database backups and the private 1.1.2 fixture are excluded from public downloads.
