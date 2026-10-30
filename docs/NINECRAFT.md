Current update: **0.4.4** — [compact upload allowance](COMPACT-UPLOAD-0.4.4.md).

Current deployed application: **0.5.0**, schema 4, three standard share slots plus room-first fallback, a 30fps selectable ceiling and the combined 450 kbps target. The operator explicitly authorized rollout despite failed capacity tests. See [release verification and limitations](RELEASE-0.5.0.md).

Current audio-controls update: **0.4.3**. See [AUDIO-FIX-0.4.3.md](AUDIO-FIX-0.4.3.md).

# Ninecraft Iranian SFU pilot — 29 October 2026

Current release 0.4.2 adds [Persian readability and chat-server ping](PERSIAN-PING-0.4.2.md), preserving the existing database and SFU/network configuration.

The current 0.4.1 voice CPU/hotkey update is deployed; see [optimization, verification and heavy-media limitations](OPTIMIZATION-0.4.1.md). The ten-user/four-share capacity gate remains failed despite reduced control-plane CPU.

The operator authorized one month at **348,000 toman**, with reduced screen bitrate and traffic monitoring. The funded account purchased `dorham`: Ubuntu 24.04, 1 vCPU, 2 GB RAM, 20 GB enterprise HDD, 120 GB incoming traffic. The panel showed 30 days and 120 GB after provisioning. Outgoing traffic is free according to the provider; no extra traffic, renewal or automatic top-up was purchased.

Pilot website: **https://dorham.45-135-242-146.nip.io/**. SFU signaling uses `voice.45-135-242-146.nip.io`; integrated TURN/TLS uses `turn.45-135-242-146.nip.io:443`. These temporary hostnames depend on external authoritative DNS. A domestic-only outage has not been tested; an Iranian host alone does not certify that condition. Replace the temporary names with operator-owned domestic DNS before making that availability claim. HTTPS certificates currently expire 27 January 2027 and have a renewal timer and HAProxy reload hook.

The v0.2 update is deployed with existing accounts retained; see [upgrade capability matrix and new operational gates](UPGRADE-STATUS.md). The private signaling proxy now enforces current admission before every `/rtc` connection, and the backend uses LiveKit's loopback control API. Reset tooling is available but has not been executed on live data.

The subsequent v0.3 social/roles update is deployed; see [SOCIAL-UPDATE.md](SOCIAL-UPDATE.md) for features, current package locations, preserved live data and verification.

The v0.4 inline-media/screen-layout update is covered in [MEDIA-UPDATE.md](MEDIA-UPDATE.md). Its deployment adds preview-grant query redaction while retaining the existing private signaling admission, HTTPS and TURN routes.

## Services and networking

- Node 24.22.1 under `dorham.service`: `/opt/dorham`, environment `/etc/dorham/pilot.env`, data `/var/lib/dorham`. The API binds only `127.0.0.1:3001`; one process owns SQLite. Systemd uses the direct Node executable, graceful shutdown, automatic failure restart and a 640 MiB hard memory limit.
- LiveKit 1.13.11 under `livekit.service`: `/opt/livekit/livekit-server`, private configuration `/etc/dorham/livekit.yaml`, 900 MiB hard memory limit. Release checksum verified before execution. Rooms retain the 16-person limit.
- HAProxy terminates TLS on TCP 443. TURN SNI routes decrypted TCP with PROXY v2 to LiveKit's private port 5349 (`external_tls` enabled); other connections route to Caddy on loopback 8080. Caddy sends the voice hostname to LiveKit 7880 and the website to Node 3001. HTTP 80 permits ACME validation and redirects other paths to HTTPS.
- UFW allows SSH 22/TCP, HTTP 80/TCP, HTTPS and TURN 443/TCP, SFU ICE 7881/TCP and 7882/UDP, and integrated TURN 3478/UDP. Backend 3001, SFU API 7880, internal TURN 5349, Caddy 8080 and admin 2019 are not publicly allowed.
- No foreign TURN account or foreign SFU is used. Server-generated authenticated LiveKit credentials accompany authorized room membership. Empty `STUN_URLS` explicitly disables the application's mesh STUN list; LiveKit advertises its own TURN/STUN.

The issued SSH password was rotated after a deployment-helper error exposed it in installer output. The replacement and bootstrap administration secret remain private. Repository source, screenshots and deployment bundles contain no usable credentials. The helper was corrected to avoid sending a password to passwordless sudo and to redact credential output.

## Publishing and traffic

Pilot environment: `MEDIA_TRANSPORT=livekit`, `SCREEN_MAX_BITRATE=450000`, `SCREEN_MAX_FRAME_RATE=12`, `MAX_ROOM_SHARES=0`, `MAX_GLOBAL_SHARES=0`. Web/Electron screen tracks use one VP8 encoding, capped at 450 kbps and 12 fps; higher resolution selections retain this ceiling. Voice publishing uses mono Opus with a 24 kbps target and discontinuous transmission. These are cooperative client publishing settings, not a network billing firewall. Android policy parity and physical testing remain open.

At two continuous screen publishers, 450 kbps each for 6 hours/day over 30 days is **72.9 GB incoming**, before audio, retransmissions and protocol overhead. Static screens can consume less, and more publishers consume more. Removing fixed publisher limits does not promise unlimited media capacity or quota.

`vnstat.service` persists interface counters. `dorham-traffic.timer` runs the source [traffic monitor](../deployment/traffic-monitor.py) every minute, writing `/var/lib/dorham-ops/traffic.json`. It estimates usage since this pilot started, adds a conservative 1 GB accounting reserve for setup/unrecorded traffic, and logs threshold transitions at 80% and 90%. It never buys traffic or stops calls automatically. The Ninecraft dashboard is the billing authority. Reconcile/reset the monitoring baseline and billing period deliberately when renewing.

```sh
sudo cat /var/lib/dorham-ops/traffic.json
sudo journalctl -u dorham-traffic.service --since today
sudo vnstat -i eth0
sudo systemctl show dorham livekit -p MemoryCurrent -p CPUUsageNSec
sudo journalctl -u dorham -u livekit --since '30 minutes ago'
```

## Verification and open gates

Passed on the new public host: registration/login, decoded/re-encoded avatars, WSS, explicit Socket.IO polling, message deduplication, edit replay and observing voice membership before joining. A single message acknowledgement measured 85.64 ms; this is not a load percentile.

Two real Chrome clients passed decoded bidirectional audio and two screen streams through the Iranian SFU, avatar activity/mute transitions, screen-first viewing and encoder limits. A separate run forced relay-only ICE and restricted configuration to `turns:...:443`; selected candidates were TLS relays and decoded media passed. Sanitized evidence: `artifacts/evidence/ninecraft-sfu-direct.json`, `ninecraft-sfu-tls.json` and their screenshots/memory reports. Combined Chrome/Edge peaked at 1952.0 MiB in the direct run and 1888.8 MiB in the forced-TLS run, below the 4 GiB guard. These are short synthetic two-client checks, not physical speech-quality, overseas, 16-person or six-hour capacity certification.

The first TLS test received media but failed its transport assertion; the test was strengthened to constrain subsequent SDK ICE reconfiguration and record sanitized configuration/selected-candidate evidence. Only the subsequent fully passing relay-only run is accepted TLS proof.

A further hosted test passed owner mute/unmute, unsubscribe/resubscribe, owner share termination and voice kick using cooperative clients (`ninecraft-sfu-controls.json`). The remaining local quiet-audio and microphone-processing regressions also completed successfully, including decoded video before the screen-focus screenshot, saved opt-out/mobile layout and capture preference/mute preservation. The earlier memory-stopped rerun is superseded by these completed focused checks.

Botkeep remains separate; its real accounts/history have not been migrated. Preserve it and its backups until an explicit migration and comparison succeed. Existing Windows installations with a saved server address retain that preference; change it to the pilot address when testing. New pilot packages use the new endpoint by default. Android installation and native SFU behavior remain untested on a physical device.

The unsigned Windows pilot installer is `artifacts/ninecraft-pilot/windows/Dorham-0.1.0-Windows-x64.exe` (SHA256 `A750C57AD383B8FF7F761DBC76994EB4D940CFFF61CE9BEDC922F114F221F0EA`). Silent installation to the isolated pilot directory exited 0. The installed application and Chrome passed decoded bidirectional SFU audio, two screen streams, speaking/mute transitions, endpoint defaults and encoder limits, with sandbox/context isolation enabled and Node integration disabled. Combined browser/test-app memory peaked at 1939.4 MiB. Evidence: `ninecraft-sfu-windows.json`, screenshot and memory report. The older installer is preserved under `artifacts/windows`.

Live restart/update preserved the existing smoke-test message and avatar hash, WSS, polling, edit replay and duplicate suppression. A verified online SQLite snapshot plus avatars was copied to private off-host storage. Integrity/foreign-key checks passed; a separate restored instance reached readiness and shut down normally. Attempting restore over the live data directory was refused with `Stop the server before restoring`. No production database was restored or overwritten. At a later idle sample, systemd cgroup memory was approximately 83.2 MiB for Node and 67.0 MiB for LiveKit, with zero failure restarts; this is not sustained-call RSS or a 16-person resource claim.

Continuation: compare the operator's physical Chrome/Windows call with a friend, and only then decide whether to import production data. Six-hour resource and quality measurements, 16-person media, quota reconciliation, domestic-only DNS/routing and cross-network results remain separate gates. The legacy numeric PID ownership receipt is still a concern for container rollouts; this VPS uses a single direct systemd process and must not be deployed with overlapping owners.

## Rebuild the pilot clients

Use the pinned patched Node runtime and committed lockfile. The ordinary source fallback remains the older Botkeep endpoint; the pilot is an explicit build configuration, preserving that older package.

```powershell
$env:VITE_DEFAULT_SERVER_URL='https://dorham.45-135-242-146.nip.io'
$env:DORHAM_PACKAGE_OUTPUT='artifacts/ninecraft-pilot/windows'
npm run package:windows
npm run deploy:bundle
```

The server ZIP contains compiled server/web assets, the runtime manifest/lockfile, deployment sources and documentation. Install runtime dependencies on Linux; do not copy Windows `node_modules`. Back up the live SQLite database and avatars, stop only the Node service, replace compiled files while preserving `/var/lib/dorham` and `/etc/dorham`, restart, and rerun persistence checks. Rebuilding is not deployment by itself. Keep signing material, SSH credentials, API secrets and database exports outside Git.
