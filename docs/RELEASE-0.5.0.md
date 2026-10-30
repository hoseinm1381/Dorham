# Dorham 0.5.0 — deployed 30 October 2026

The operator explicitly requested deploying 0.5.0 after reviewing the failed capacity tests. That instruction supersedes the earlier capacity-related rollout hold. The failed tests remain failed; this release does not certify ten-user/three-stream sustained capacity, 16-person voice, unlimited fallback capacity or Iran-only outage availability.

Web/backend are deployed at https://dorham.45-135-242-146.nip.io/ with schema 4. Existing accounts, messages, files, roles and channel overrides were preserved. A coordinated private pre-upgrade database/files/configuration backup was downloaded independently and checked against all 35 original table digests before migration. A restored copy was migrated and checked, and the previous binary was tested against the additive schema for code rollback. The previous application remains at `/opt/dorham-before-0.5.0`; private backups remain outside the public application directory.

## Included changes

Persistent compact gaming voice controls; deliberate stream watching and a large viewer/chat drawer; optional multi-view up to three; own preview; collapsible members; grouped settings and version display; output routing and saved participant levels; independent stream gain/mute and deafen/PTT behavior. Draft persistence, pending/failed/retry states, read visibility, bounded history, request deadlines and revisioned permission editing are included. See [implementation details](GAMING-0.5.0.md).

Three standard share leases are global and eligible for 30fps. Every new share starts at 720p/15fps. A room without a publisher can obtain one 15fps fallback while standard slots are full. Oldest fallback promotion enables a 30fps choice without raising capture automatically. The pilot now uses STANDARD_SHARE_SLOTS=3, legacy hard ceilings=0, SCREEN_MAX_FRAME_RATE=30 and SCREEN_MAX_BITRATE=450000. The combined encoding budget remains 450 kbps; protocol overhead is additional. It is not a billing firewall.

Screen sound defaults off. Browser tab audio is available on supported capture paths. Windows system-loopback sound remains disabled until actual OS own-audio exclusion is verified. Android remains deferred. Saved server addresses are preserved; the unsigned Windows 0.5.0 installer uses the existing pilot default.

## Release verification

- Existing lint, types, 79 unit/API/contract tests, SQLite/PostgreSQL allocation and migration/restore tests, production builds, browser suites and installed Windows/background hotkey checks pass for the unchanged application candidate.
- Live migration preserves the original columns and rows of all 35 tables (with the expected new schema-migration record), and checks SQLite integrity/foreign keys. Avatar/attachment bytes are compared against the coordinated backup.
- Public HTML matches the final web build. Web and installed Windows both display version 0.5.0. Live revisioned override saves, stale/legacy rejection and idempotent message delivery pass in manifest-owned test resources.
- A public HTTPS/WSS Windows/Chrome test decodes voice and screen video in both directions through forced TURN/TLS, verifies deliberate watching, deafen silence, standard-tier display, and preserving voice when the viewer closes. Synthetic sources do not certify physical acoustic or OS capture behavior.
- Live proxy checks verify separate source budgets and spoofed forwarding-header rejection. Backend and intermediary listeners stay on loopback. No proxy module or runtime dependency was added; see [deployed trust path](PROXY-0.5.0.md).
- All six temporary production-check accounts and three test servers/rooms from the release checks are removed by exact manifest ID, username, creation-time and ownership checks. Original six accounts, one server and sixteen messages remain.

Chromium intermittently failed DNS resolution for the temporary nip.io host. The accepted automated media check pinned the known IP only in its temporary Chrome/Electron processes, retained certificate verification, and used the real public HTTPS/WSS routes. Normal system-resolver HTTP checks also pass. System DNS, production hostnames and saved user addresses were not changed. Earlier verification attempts include an incorrect test response assertion and an interrupted navigation/DNS check; their logs are retained, and only the final pass is accepted.

## Remaining limitations and continuation

The ten-user capacity and retest failures remain documented in [measurements](GAMING-0.5.0-MEASUREMENTS.md) and [retest details](CAPACITY-RETEST-2026-10-30.md). Investigate heartbeat acknowledgements, Socket.IO disconnect reasons, client timer lateness and the test/control network path, then repeat across distributed devices. A matched old/new CPU comparison remains outstanding. Do not lengthen leases merely to hide disconnects or infer capacity from connection establishment.

No paid upgrade, traffic purchase, account reset, Android build or hosting/domain migration was performed. Before any future data rollback, preserve newer user data; do not restore the old snapshot over newer messages. The previous code can use the tested additive schema, and failed/new state must be retained during rollback.

Exact hashes, source commit, live verification and backup proof are recorded in `artifacts/evidence/v050-release.json`. Installer/source/server deliverables and SHA256SUMS are under `artifacts` / `artifacts/v0.5.0`.
