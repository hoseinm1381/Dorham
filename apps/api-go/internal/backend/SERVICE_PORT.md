# Service domain port and compatibility checks

The Go implementation in `service*.go` ports every method in the TypeScript
`apps/api/src/service.ts`, plus member moderation, share policy, TURN credentials,
the permission resolver, mentions, and TTS command parsing. It runs application
logic directly in Go. It does not call or proxy the old Node service.

The persisted SQL schema, role hierarchy, error codes, message/event sequences,
voice epochs, share policy revisions, and public response fields stay compatible.
All authorization runs against the caller's current database transaction. There
is no persistent permission or notification-audience cache.

`core_routes.go` registers the non-auth, non-media and non-game HTTP routes.
Validation mirrors the existing contracts: ordinary objects discard unknown
fields, role/moderation bodies reject unknown fields where the original schema
was strict, text limits count UTF-16 units, and omitted reply targets remain
distinct from explicit null. HTTP and Socket.IO share `CoreMessageBody`.
`core_reactions.go` contains the exact 65 existing reaction keys, including the
five legacy Unicode mappings; no stored reaction keys are renamed.

Mutation receipts written by Node used insertion-ordered `JSON.stringify`
fingerprints. `service_receipts.go` reconstructs each original operation's schema
order, including nested permissions/game settings/actions, and accepts the exact
legacy fingerprint alongside the new canonical fingerprint. Different input
still returns `IDEMPOTENCY_CONFLICT`. Transactions roll back a failed operation
before writing any receipt. Missing and null reply targets remain distinct.

## Verified local gate

The focused suite passed all 13 tests on its first execution:

* HTTP contracts, unknown-field stripping, strict bodies, Persian text, reaction
  catalog validation and timeout enforcement.
* Permission deny precedence, owner privileges, peer moves, and protected mention
  parsing outside URLs, emails, escaped text and code spans.
* Idempotent replay, legacy Node receipts, conflicts and rollback.
* Messages, mention recipients, edits/deletes, reactions, history/event replay,
  cursor bounds and stale event resets.
* Private DMs, block rules, hide/reopen behavior and guest isolation.
* Invitations, exhaustion, guest policy, membership limits and hierarchy.
* Custom roles, channel override revisions and timeouts.
* Voice socket takeover/epoch fencing, liveness, mute/deafen restrictions, peer
  moves and stale session cleanup.
* Voice tags, locks, room limits and directory privacy.
* Share tier allocation/promotion, lease ownership, revision fencing and cleanup.
* Ban/unban capabilities and the owner/admin/moderator hierarchy.
* Authorized message/voice snapshots and TTS callback boundaries.
* Real HTTP TURN provider filtering, bounded single-flight caching, isolated
  response copies, and safe failure messages without provider credentials.

Command: `go test -p 1 ./internal/backend -run '^TestCore' -v -count=1`.
Evidence: `artifacts/logs/v110-go-core.log` and
`artifacts/evidence/v110-go-core.json`. The fixture uses private temporary SQLite
databases, generated accounts and local `httptest` servers. It never writes to
production. A static comparison also found all 194 distinct reference SQL
literals in the port; that is a coverage aid, not a runtime correctness claim.

This focused gate does not establish full release readiness. Browser/native
client compatibility, SFU audio/video, load/resource measurements, production
data migration and rollback remain separate release gates.
