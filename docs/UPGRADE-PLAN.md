# Dorham expansion checkpoint — 29 October 2026

Source request: the owner's feature expansion, security and domestic infrastructure prompt. Extend the existing Fastify/SQLite/PostgreSQL, React, Electron, Capacitor and LiveKit workspaces; no new backend services or paid dependencies.

## Confirmed product decisions

- Build an explicit, backup-first account reset tool. **Do not reset live accounts.** Preview changes and require an offline operator confirmation. Preserve servers/channels/settings by transferring ownership; preview the loss of account-related messages/DMs. Preserve the original backup outside the data directory.
- Recovery uses one-time recovery codes and an audited super-admin temporary reset. Optional salted/hashed security answers are supporting information only, never a standalone reset credential.
- Guests choose a display name, persist through refresh, join through invitations, and may message and use permitted voice channels. Server guest access defaults on and may be disabled. Guests cannot upload files. Conversion preserves identity and memberships and grants no roles.
- Keep 16 users per voice room. The owner previously removed fixed room/global screen publisher limits; preserve that choice, leases and one publication/account.
- Keep the paid pilot's publishing ceilings until explicitly changed. Quality choices are capture targets constrained by the administrator's bitrate/frame-rate policy; 30 fps choices cannot promise 30 fps on a 12 fps server.
- No additional purchase, hosting change, or destructive production operation is authorized by this update.

## Implementation sequence and acceptance gates

1. Shared contracts, additive versioned migrations, runtime dependency audit, safe message links and channel navigation, four screen modes (480/720 at 15/30), in-call quality controls.
2. Guest identities/conversion/restrictions, 8-character password validation, device-session management/renewal, recovery codes/supporting questions, single protected global administrator, audit records and backup-first offline reset.
3. Streaming filesystem attachments: binary MiB limits (10/100/300), transactional rolling quota/reservations, bounded concurrency, protected downloads, crash reconciliation and bounded expiry/space-pressure eviction. Configure a disk reserve and attachment budget on the existing 20 GB disk.
4. Server-scoped tags and ANY/ALL voice gates; lock/user-limit policy and immediate permission revalidation; hierarchy checks, server deafen, move/disconnect, SFU publish/subscribe enforcement and audit UI.
5. Full local English/Persian dictionaries, preference persistence, RTL/LTR and mixed-content layout, localized errors/authentication/settings/moderation. No translation API or external font.
6. Integration/negative/concurrency tests, upgrade migration from v1 and PostgreSQL adapter checks, real-backend browser regression, decoded-media/quality checks and guarded desktop/native builds. Preserve evidence and report untested physical-device and sustained-load gates.
7. Backup, controlled deployment and persistence/rollback check after local gates. Domain/DNS remains pending IRNIC approval. A restricted-network test must allow only domestic app/media paths and independently verify DNS. Do not claim a real nationwide outage test or full domestic certification from a local allowlist test.

## Runtime audit baseline

- Ninecraft serves application, SQLite, signaling, SFU and integrated TURN locally; no foreign relay is configured there.
- Frontend assets, Lucide icons and system fonts are local. Native clients use their configured origin.
- Source defaults still contain legacy Botkeep and Google STUN addresses; remove implicit foreign dependencies for new builds and require explicit instance configuration.
- `deployment/start.mjs` contains an older automatic Node download fallback. Domestic deployments must provision the runtime beforehand and fail clearly instead of attempting downloads on startup.
- Optional Cloudflare TURN is an explicit operator integration, not a domestic-compatible default. External user message links are optional navigation, never essential app requests.
- Temporary `nip.io` names depend on foreign authoritative DNS. `dorhamapp.ir` is paid but awaiting registry approval as reported by the owner. Registration alone does not verify domestic authoritative DNS or routing.

Every section remains pending until its source and corresponding tests are recorded. Existing deployment acceptance does not certify new features.
