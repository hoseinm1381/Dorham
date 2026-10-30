# Dorham 0.5.3 — your microphone gain

**Account settings → Audio → My microphone gain** adjusts the voice you send to everyone from 50% to 250%, in 5% steps. The default and reset value is 100%. The preference is saved on this device/browser, applies during a call and is restored on future joins and page reloads. The same control is available in voice connection settings. English and Persian labels are included.

Gain runs after browser capture processing and before WebRTC encoding. It affects your outgoing microphone, independently of each listener's per-person volume and stream sound. A gain of 250% means 2.5 times the signal amplitude, approximately +8 dB; perceived loudness depends on the input and listening equipment. Excess gain can clip a loud microphone, so the control includes a short explanation and reset button.

The browser and Windows app use a small Web Audio source → gain → outgoing-track graph. The graph has no local speaker connection. SFU capture uses the SDK track processor lifecycle; capture restart/device changes rebuild the graph. The direct-media transport sends the processed track and retains the source capture for constraints and mute enforcement. Leaving stops owned output tracks and disconnects the graph. Source processing diagnostics continue to read capture settings rather than settings on the generated track. Android builds remain deferred, and the unsupported native adapter does not advertise this control.

Mute, deafen, server moderation and talk controls retain priority. Changing gain while muted must remain silent. The SDK microphone creation path installs the processor on a muted track before publishing, then uses the latest talk/mute state. The control can resume a suspended processing context during its gesture.

## Verification

Lint, TypeScript and 89 unit/API tests pass. Decoded-audio Chrome tests measure outgoing gain at 50%, 100%, 150% and 250% from a separate receiving client, through both direct WebRTC and the SFU with forced TURN/TLS. They cover a saved value before first join, changing gain while muted, muted input-device replacement, deafen, leave/rejoin, reload and reset. The received encoded signal is checked within 5% relative tolerance. Initial SFU checks exposed startup settling and a 3.6% post-reload codec variation; the test now warms up the decoder and applies the same relative tolerance at every gain. These are synthetic input/decoded-signal measurements, not physical microphone or acoustic certification.

All seven core browser scenarios pass, including talk controls and live capture processing. Two additional SFU scenarios verify talk bindings and actual Chrome capture-processing changes. The installed Windows app passes registration, decoded inline media, own screen preview, protected credentials, sandbox/tray, Persian font and actual OS-injected background talk-key checks. The NSIS installer exits 0, and its 13 installed web files plus four desktop shell files match the final build.

Public HTTPS/WSS Chrome-to-Windows and Windows-to-Chrome tests pass through forced TURN/TLS, with process-only DNS pinning and normal certificate validation. Received RMS at 50/100/250% is approximately 0.0281/0.0563/0.1404 from Windows, and 0.0286/0.0574/0.1394 from Chrome. Per-person 0–200% playback, suspended playback recovery, member invitations/owner switch, bidirectional decoded screens and deafen also pass. Normal system-DNS HTTPS readiness and exact deployed HTML checks pass.

Packaging, live checks, backup/preservation evidence and hashes are recorded in `artifacts/evidence/v053-release.json` and `artifacts/v0.5.3`. The production bundle dependency audit reports zero vulnerabilities.

## Deployment boundaries

This patch does not change the database schema (still schema 5), dependencies, hosting configuration, media budgets or sharing limits. The release is live at https://dorham.45-135-242-146.nip.io/. An independently downloaded backup verifies all 35 tables and four stored data files. Rollout preserves the original digests of all 32 persistent tables, three avatar/attachment files and configuration. All four services are active. The previous application remains at `/opt/dorham-before-0.5.3`; restored-copy migration and previous-code/schema compatibility checks pass. Two public release-test accounts and one server were removed using exact manifest identity, ownership and timestamp checks. The live application retains its seven real accounts, three servers and 25 messages.

The Windows installer is unsigned. Android and physical acoustic/device testing remain deferred. The earlier failed ten-user media capacity gate remains unresolved; this patch does not certify additional capacity.
