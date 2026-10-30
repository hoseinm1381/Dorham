# Dorham 0.5.2 — member invitations and browser voice volume

This update enables invite creation for server members by default and makes positive voice-volume gestures recover suspended browser playback. Android builds remain deferred. Sharing allocation, media budgets and voice/member limits are unchanged.

## Invitations

Every member, including an invited guest, can create an invitation unless an explicit custom-role deny or the owner's server setting prevents it. A visible **Invite people** button opens invitation management. Ordinary members see and revoke their own links; owners and moderators retain oversight of all server links. Nonmembers cannot create or read invitations.

Only the owner can change **Allow members to create invite links** in the server overview. Turning it off prevents new invitations from nonowners, including administrators and custom-role grants. Previously issued links stay valid until revoked, exhausted or expired. The owner can still create and revoke links. Existing explicit role restrictions are preserved.

Schema 5 adds `servers.allow_member_invites`, defaulting to enabled for existing and new servers. Migration/restore tests retain accounts, messages, attachments, ownership and saved permission overrides.

## Voice volume

The per-person slider controls local playback gain from 0 to 2: 0% is silence, 100% is the original signal and 200% doubles signal amplitude (approximately +6 dB). It does not change another person's microphone gain or their stream-sound level.

Positive volume gestures now immediately request playback recovery from Chrome's audio context, then reapply the latest gain after readiness. Concurrent gestures coalesce. Gains are also applied after track attachment and restored on SFU reconnect. The direct-media transport resumes its suspended playback context on the same gesture. Deafen and local zero-volume choices retain priority.

Controlled decoded-media tests reproduce the old failure after deliberately suspending the playback context: moving the slider changed the saved value but playback stayed silent. The updated build recovers and measures roughly 0.5× and 2× amplitude at 50% and 200%, with silence at 0%. Rejoin, reload, saved levels and deafen are tested. This models a suspended Chrome playback path; it does not establish that every reported volume problem has that cause or measure physical speaker loudness.

The initial rejoin test clicked before Disconnect finished. That test timing was corrected; a speculative SDK-room replacement was removed. Neither that failed test nor the removed change is treated as a product fix.

## Verification and rollout

Lint, TypeScript, 87 unit/API/contract tests and API/web/desktop builds pass. Focused Chrome SFU decoded-audio tests pass through forced TURN/TLS with synthetic input. Owner/member invitation and direct-media UI results, installed Windows verification, deployment preservation, final package hashes and cleanup are recorded in `artifacts/evidence/v052-release.json` and `artifacts/v0.5.2`.

The release is deployed at https://dorham.45-135-242-146.nip.io/ with schema 5 through the previously authorized pilot/GitHub workflow. An independently downloaded backup verifies all 35 pre-upgrade tables and four stored data files. Migration preserves the original columns/digests of all 32 persistent tables and three avatar/attachment files; transient voice state resets on restart. Configuration is unchanged and all four services are active. A restored copy migrates successfully, and the previous binary accepts the additive schema. The previous application remains at `/opt/dorham-before-0.5.2`.

Public Windows/Chrome HTTPS/WSS verification passes for member invite creation, owner disable/re-enable, bidirectional decoded voice/screens, deafen, explicit watching, revisioned permissions and message deduplication. Chrome's measured receive RMS is approximately 0 at 0%, 0.0280 at 50%, 0.0558 at 100% and 0.1122 at 200%; a deliberately suspended playback context resumes after moving the slider. This uses synthetic input through forced TURN/TLS, with test-process DNS pinning and normal certificate verification. Normal system-resolver HTTPS readiness and exact deployed HTML checks also pass.

The Windows installer exits successfully, its payload matches the built application, and the installed app passes registration, protected credentials, sandbox/tray behavior, decoded inline media and background talk-key safety checks. Six existing core browser scenarios pass on the first run; one media scenario times out while installer compression runs, then passes unchanged in an isolated retry. Its failed log is retained.

No paid services, proxy changes, account resets or hosting migration are included. The Windows installer is unsigned. Release-test resources are removed by exact manifest identity, ownership and timestamp checks; real accounts, servers, history and files remain intact.

The earlier ten-user media capacity failure remains unresolved and is not reclassified as a pass. Distributed capacity, Iran-only outages and physical acoustic/device behavior remain separate acceptance gates.
