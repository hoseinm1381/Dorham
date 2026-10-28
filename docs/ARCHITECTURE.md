# Architecture

## Control plane

One Fastify process serves the built frontend, `/api/v1`, Socket.IO, readiness endpoints, and bounded avatar files. SQLite defaults to a local persistent data directory, WAL, foreign keys, a busy timeout, a page ceiling, and bounded journal retention. The PostgreSQL adapter uses Drizzle's node-postgres driver and the same parameterized SQL/schema. No Redis or media forwarding runs inside the control plane.

SQLite reads and writes are serialized through one queue; complete transactions hold that queue across their asynchronous service operations. PostgreSQL transactions lock the singleton `global_locks` row before capacity-sensitive changes. The service layer checks membership and permissions inside the transaction. All application SQL comes from source; user input is bound through Drizzle parameters.

Durable mutations deduplicate `(user, requestId)` and reject identifier reuse with different input. Messages, conversation sequence changes, and replay events commit together. The socket acknowledgement follows commit. Every private event is authorized again before delivery, so a stale socket subscription does not retain access after membership or permissions change. Socket.IO recovery reruns authentication middleware. Conversation replay handles a missed recovery or server restart; expired replay windows request a fresh history snapshot.

Authentication handshakes create fresh opaque credentials. Passwords use Argon2id with two concurrent hashing jobs and a 19 MiB memory cost per job. Sessions retain only token hashes. Web clients use HttpOnly/SameSite cookies and CSRF proofs. Native clients use short-lived bearer access credentials and rotating refresh credentials protected by Windows safeStorage or Android Keystore. Reusing a retired refresh token revokes that session family. Lost refresh responses can require signing in again.

Presence and connected-user capacity are process-local. Voice membership is transient and persisted only for transactional coordination; startup discards previous members and advances coordinator epochs. An exclusive instance lock prevents two servers from using the same data directory. Run one backend process per instance.

## Mesh media

`MediaTransport` exposes join/leave, mute/deafen, per-user gain, device selection, publish/stop screen, subscribe/unsubscribe, diagnostics, and disposal. Browser and Electron clients use WebRTC directly; Android owns native WebRTC connections through the Kotlin plugin.

Each mesh participant sends directly to every other participant. The signaling server validates both endpoints' current membership, source epoch, and screen lease before forwarding a signal. Browser negotiation uses the perfect-negotiation pattern, trickle ICE, pending-candidate buffering, and bounded ICE restart attempts. TURN credentials can be static or derived from a shared TURN secret with an expiry. TURN credentials are never embedded in the frontend build.

The first eligible active participant becomes **room coordinator**, not an SFU. Eligibility comes from client capability/connectivity checks and live heartbeats; it grants no administrative privilege. Five-second heartbeats and a 15-second coordinator lease trigger fenced migration. Voice and screen leases expire after 30 seconds without valid refresh. A normal disconnect releases them immediately. Screen reservations check both room and global totals in one transaction.

Screen receive controls tell each publisher to pause that viewer's screen sender. They do not stop other viewers. Local audio uses an audio element routed through Web Audio gain nodes; this supports playback, local mute, amplification, and speaking detection. Audio elements and capture tracks are disposed when peers leave. Screen capture defaults to 720p/15fps, with congestion-based bitrate/frame-rate adjustment.

Mesh does not reduce the publisher's upload fan-out. At 16 members, a screen publisher can send 15 separate video streams. Device and upstream bandwidth determine whether that is practical, even when the control plane is inexpensive. Direct peers can learn one another's network addresses. DTLS/SRTP protects WebRTC transport; no application-level end-to-end identity/encryption guarantee is asserted.

## External SFU

Set `MEDIA_TRANSPORT=livekit` and supply the LiveKit URL/API credentials. The backend issues short-lived, source-scoped room credentials only for an active authorized voice membership. Microphone publication follows speaking permissions and moderator mute; screen publication additionally requires an active lease. The server reconciles participants and publication permissions after control changes and during maintenance.

LiveKit runs on an operator-controlled external host with the documented public address, UDP/TCP, TLS, and TURN configuration. It is not installed inside Botkeep. Its API key remains on the backend. Previously issued credentials have a short validity window; external SFU/API outages and token revocation behavior require deployment-specific validation. Automatic participant-operated native SFU forwarding is not implemented.

## Native applications

Electron loads packaged assets under a secure custom scheme, with context isolation, renderer sandboxing, no renderer Node access, strict IPC sender checks, and a narrow preload interface. A user chooses the desktop source through a native dialog. Closing the window while in voice hides it to the tray; quitting disconnects the application.

Android uses one prefixed native WebRTC dependency shared with LiveKit. Kotlin owns capture, peer connections, volume, audio routes, MediaProjection consent, and native video surfaces. A foreground service advertises the active microphone/capture and drives periodic control-plane pulses. Background behavior, Bluetooth transitions, OEM power management, and forced OS termination require physical-device testing. Force-stopping the app cannot preserve voice. Android Keystore credentials are excluded from Android backups.

## Primary references

- [Botkeep Node.js deployment](https://botkeep.cloud/docs/nodejs)
- [Botkeep HTTP hosting and persistence](https://botkeep.cloud/hosting/nodejs)
- [Socket.IO recovery](https://socket.io/docs/v4/connection-state-recovery/)
- [Electron desktop capture](https://www.electronjs.org/docs/latest/api/desktop-capturer)
- [Android MediaProjection](https://developer.android.com/media/grow/media-projection)
- [LiveKit deployment](https://docs.livekit.io/transport/self-hosting/deployment/)
- [LiveKit Android dependency catalog](https://github.com/livekit/client-sdk-android/blob/main/gradle/libs.versions.toml)
