# Domestic connectivity and reproducible runtime

Iran-only service means the domestic server remains reachable while international connectivity is unavailable. It does not mean messaging works without a reachable backend.

## Required paths

- Website/API/SQLite, Socket.IO, LiveKit and integrated TURN are on the Iranian VPS. Public application and media names must resolve through authoritative DNS reachable inside Iran. A purchased `.ir` label alone does not prove this.
- The temporary `nip.io` names still depend on external authoritative DNS. The owner reports `dorhamapp.ir` paid and pending IRNIC approval. Configure and independently verify domestic authoritative DNS and its delegation before claiming domestic-only reachability.
- Point the website, voice and TURN names at the VPS, issue trusted certificates in advance and keep certificates valid. An extended outage spanning certificate renewal/expiry is another availability boundary. The browser cannot use a bare public HTTP IP for microphone/screen capture.
- Clients use public `LIVEKIT_URL=wss://voice.your-domain.ir`. The backend uses **`LIVEKIT_API_URL=http://127.0.0.1:7880`** for control traffic, avoiding public DNS/TLS paths for local permission enforcement.
- LiveKit uses an explicit public node IP with external-IP discovery disabled and an empty foreign STUN list. Integrated TURN advertises the same domestic host. The source default STUN list is empty. Optional managed Cloudflare/TURN integrations must remain unconfigured for this deployment.

## Prepare before restricted connectivity

Use the committed lockfile and patched Node 24.22.1 (or a later maintained patch within Node 24). Build the local React assets, API and native packages while build registries are available. Install Linux native dependencies on the matching Linux architecture; never copy Windows `node_modules` to Ubuntu. Prepare the Node and LiveKit binaries and the runtime dependency tree in advance and keep a checksum-verified, private recovery copy.

Application startup now **fails clearly if the expected Node runtime is absent**. It does not download Node, JavaScript packages, binaries or fonts. Run the systemd service with the preinstalled Node executable, not an installer command. `npm ci`, Gradle/Maven, SDK downloads, release retrieval, certificate issuance and GitHub fetches are preparation/maintenance dependencies, not required call/message paths.

Frontend JavaScript/CSS, icons and dictionaries are bundled locally; fonts use the installed system stack. No external authentication, analytics, CAPTCHA, translation, file storage or push service is needed for core use. User-clicked external message links are optional navigation. The service worker caches the public application shell and excludes API, conversation, socket and avatar data.

## Ports and service ownership

See NINECRAFT.md for the deployed service layout. Public: TCP22 for administration, TCP80/443 for HTTPS/ACME/TURN-TLS, TCP7881 and UDP7882 for SFU media, UDP3478 for TURN. Private loopback: Node3001, Caddy8080/admin2019, LiveKit7880 and internal TURN5349. Keep raw application/control ports private and one process responsible for SQLite. Preserve firewall/routing rules and volume ownership when moving providers.

`/health` and `/ready` check the application/database; separately check `systemctl is-active dorham livekit caddy haproxy`, local LiveKit HTTP readiness, trusted public HTTPS/WSS and an actual decoded-media session. TCP connection establishment alone is not media validation. The existing traffic monitor continues accounting for incoming bytes.

## Enforcing current media permissions

Self-hosted LiveKit does not automatically invalidate cached/refreshed participant tokens when a participant is removed or permissions change. See the [official token lifecycle](https://docs.livekit.io/frontends/reference/tokens-grants/). Short tokens and periodic synchronization alone do not make revocation immediate.

The expansion includes a private signaling admission endpoint and [Caddy snippet](../deployment/Caddyfile.media.example). Configure a separate random `MEDIA_ADMISSION_SECRET` in private Node/proxy configuration. Apply `forward_auth` to `/rtc` and `/rtc/*`, including validation/reconnect requests. It validates the JWT and current room/epoch, account, authenticated control socket/session, publish sources, screen lease and listening permissions. It handles browser query tokens and Android Authorization headers. Reject public access to `/internal/*` on **both** website and voice hosts; never log forwarded token-bearing URIs or the secret. The LiveKit control API should use loopback. Validate Caddy configuration before atomic reload and test negative stale-token reconnects against the deployed proxy. Do not equate a passing direct-handler unit test with a deployed proxy gate.

## Verification boundaries

The guarded expansion browser scenario runs against a real local backend/database while aborting foreign HTTP requests. It covers guest registration/conversion, login, messages, authorized internal navigation, streaming files and language preference. It records allowed/blocked application requests. This proves those paths under that controlled restriction; it is **not** an Iranian DNS, nationwide-outage, physical Android or cross-network-media certification.

For deployment acceptance, restrict only a test service/client's network paths, retaining the domestic app/SFU/TURN and administrative recovery path. Check login/registration, guests, text, links, upload/download, media, moderation, renewal and restart. Record actual selected ICE candidate endpoints and decoded audio/video. Never change the entire workstation DNS/VPN or lock out SSH as a shortcut. Use the 4 GiB browser guard and distributed machines for 16-participant capacity tests. Actual domestic-only DNS/outage certification remains pending until those environments can be tested.
