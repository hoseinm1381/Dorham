# Deployment

## Botkeep preparation

The public Botkeep documentation describes GitHub/ZIP import, runtime environment variables, a persistent volume, assigned HTTP ports, and Domains/HTTPS routing. It instructs HTTP applications to bind `0.0.0.0` and `SERVER_PORT`. It does not establish that this account's allocation, WebSocket upgrade behavior, exact volume mount, or native module installation has been verified. These remain live deployment gates.

The Halloween plan is a shared account pool: 1 vCore, 1 GiB RAM, 1 GiB storage, three slots. Use **one slot** for this application; reserve the pool for it while measuring. Builds, desktop/Android packages, `node_modules` from Windows, test data, logs, signing keys, and `.tools` must not be uploaded.

1. Run `npm run verify`, the browser tests, and `npm run deploy:bundle` locally.
2. Import `artifacts/Dorham-0.1.0-Botkeep.zip`, or use a private deployment repository containing the contents of `artifacts/botkeep`. Connecting/importing a repository is an operator action; this project does not push or publish automatically.
3. Select a patched supported Node 24 runtime. Install with `npm ci --omit=dev` and use `npm start`. Do not upload Windows-native dependencies.
4. In Environment, configure `NODE_ENV=production`, `HOST=0.0.0.0`, `PUBLIC_URL=https://<assigned-domain>`, `COOKIE_SECURE=true`, and `ALLOWED_ORIGINS=https://<assigned-domain>,https://localhost,dorham://app`. Keep Botkeep's assigned `SERVER_PORT`.
5. Set `DATA_DIR` to the **actual persistent-volume path shown in your panel**. Do not assume `/tmp`, the import directory, or a particular container path survives redeployment.
6. Configure Domains/HTTPS and verify `/health` and `/ready` from outside the hosting network.
7. Set a random bootstrap administration secret through Environment, claim it in the application, and then remove the secret from the environment. The database records that it has already been claimed.

The application loads `.env` where provided. Environment values override `.env`. Do not include real secrets in source, ZIPs, screenshots, or support logs.

## Mandatory live gates

- Create two accounts and exchange chat in two independent browsers.
- Confirm Socket.IO establishes a WebSocket upgrade over HTTPS and survives a long idle connection, reconnect, and application restart. If upgrades fail, test polling explicitly; record which transport actually works.
- Create a message and avatar, restart the process, and confirm both persist. Repeat through an actual repository/ZIP update; avoid replacing the data directory.
- Confirm Linux native modules load and memory/disk allocation is real. Record process RSS, CPU, database/WAL, dependencies, free space, and provider measurements during representative traffic.
- Test microphone/screen capture over the public HTTPS origin. Test direct connectivity from different networks and TURN where direct ICE fails.
- Test expiration and reconciliation against the actual external SFU before claiming enforced media moderation.
- Export a successful backup, restore into a separate local instance, and verify history before admitting important data.

If the provider does not offer durable SQLite files, configure a supported PostgreSQL service in another slot through `DATABASE_URL`; it shares the same account budget. Prove persistence for that service too. Moving existing SQLite data to PostgreSQL requires an explicit export/import migration and verification; changing the URL alone does not transfer records. Keep the source database and backups. If ingress or persistence cannot be provided within the plan, keep the application local or move it to a VPS rather than claiming Botkeep readiness.

## TURN and LiveKit

Use an externally operated TURN service, supplied through `TURN_URLS` and either static credentials or `TURN_SECRET`. The latter generates expiring HMAC credentials compatible with a configured TURN REST shared secret. STUN alone cannot guarantee connectivity across restrictive NATs.

For LiveKit, set `MEDIA_TRANSPORT=livekit`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET`. Follow [the official deployment guide](https://docs.livekit.io/transport/self-hosting/deployment/) for public addressing, TLS, and UDP/TCP ports. Keep media services outside Botkeep unless the provider explicitly approves them: [its terms](https://botkeep.cloud/terms) restrict unauthorized relays and excessive network use.

## VPS

Use the same deployment directory, Node 24, a persistent data directory owned by the service user, and one application process under systemd or a container. Terminate HTTPS at Caddy/Nginx and forward HTTP **and WebSocket upgrades** to port 3001. Keep that backend port private. The supplied Dockerfile uses the deployment bundle as its build context:

```sh
docker build -f deployment/Dockerfile -t dorham artifacts/botkeep
docker run --name dorham --restart unless-stopped -p 127.0.0.1:3001:3001 \
  --env-file /secure/dorham.env -v dorham-data:/data dorham
```

Stop the old instance, export an online database snapshot plus avatars, restore them to the persistent VPS directory, start the new instance, and validate accounts, messages, invites, and native login. Keep the old host and backup intact until acceptance. No database schema rewrite is needed for a SQLite-to-SQLite move.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| HTTP unreachable | `0.0.0.0`, assigned `SERVER_PORT`, Domains routing, readiness logs |
| Login cookie disappears | HTTPS, `COOKIE_SECURE`, same public origin, correct allowed origins |
| Native client cannot connect | HTTPS endpoint, trusted certificate, native origins, saved server URL |
| Chat reconnects repeatedly | Upgrade headers, provider timeouts, polling behavior, capacity error |
| Voice connects but peers cannot hear | Microphone consent, local/server mute, output route, inbound sample counters |
| ICE fails | External TURN availability and credentials; test between different networks |
| Share capacity stays occupied | Heartbeat/disconnect logs; expiration must occur within the lease interval |
| State disappears after update | Actual persistent mount and `DATA_DIR`; restore verified backup |
| Native module load fails | Node version/platform and clean Linux `npm ci`; never copy Windows modules |
| `instance.lock` blocks startup | Verify the recorded process; do not remove a live instance's lock |
| Storage full | Export backup, inspect metrics, reduce retention safely, preserve editable/deployment sources elsewhere |
