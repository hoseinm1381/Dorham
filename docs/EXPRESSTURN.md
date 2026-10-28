# Free relay configuration and verification

On 28 October 2026 the operator created an ExpressTURN account and authorized its free relay credentials for Dorham's private Botkeep Environment. No Premium purchase, card entry or billing activation was performed. [ExpressTURN's published free plan](https://www.expressturn.com/) allows 1,000 GB/month over TCP/UDP port 3478. Do not assume its Premium TLS/443, regional selection, shared-secret authentication or usage reporting are included in this free account.

The current deployment uses the existing static TURN adapter, with these private environment settings:

```dotenv
TURN_URLS=turn:free.expressturn.com:3478?transport=udp,turn:free.expressturn.com:3478?transport=tcp
TURN_USERNAME=<operator-supplied relay username>
TURN_PASSWORD=<operator-supplied relay password>
```

Save username/password as secrets. Preserve the other deployment variables, leave `TURN_SECRET` and both `CLOUDFLARE_TURN_*` variables empty, and restart the application after delivery completes. Startup stays `npm start`. No application source deployment was necessary: live compiled revision `eba59f5` already supports static TURN. No TURN traffic is relayed by Botkeep; clients use ExpressTURN directly.

Authenticated, authorized voice participants receive the ICE credentials needed by their WebRTC client. This free plan uses shared long-term credentials, so an operator cannot revoke an individual modified client's relay access merely by removing its voice membership. Rotate credentials through the provider and update/restart Dorham if necessary; existing calls must rejoin. Never commit credentials, private environment files, network traces containing credentials, or backups. The optional Cloudflare adapter remains prepared but disabled because its activation requires billing.

## Verified results

- Local backend with a fresh database: two Chrome clients forced to `iceTransportPolicy: relay`, selected relay-to-relay pairs, decoded audio with nonzero audio energy, two simultaneous decoded non-black canvas streams and unsubscribe/resubscribe passed.
- Actual public Botkeep backend: the same forced-relay media checks passed using only the ICE configuration issued by `https://dorham.bot-keep.xyz`. This proves that the restarted hosted process loaded the configured credentials.
- Newly built NSIS Windows installer: installed in an isolated directory, sandbox/context isolation enabled and renderer Node integration disabled; native registration, room joining, decoded bidirectional audio and two screen publishers with Chrome through the public backend/relay passed. Microphones/capture sources were synthetic.
- All media runs used the 4 GiB memory guard. The installed Windows run includes its owned Dorham process tree in the measurements. Sanitized candidate/RTP evidence, screenshots, memory samples and logs are under `artifacts/evidence/{external-relay,hosted-relay,windows-hosted-relay}*` and `artifacts/logs`.

These are short functional tests from one VPN-connected workstation, not sustained quality certification. Some measured paths had high latency/loss. The operator subsequently confirmed the follow-up call worked and requested noise/echo processing controls; see [audio processing](AUDIO-PROCESSING.md). Physical Windows capture and quantified acoustic attenuation still need acceptance. Android hardware, long calls, restrictive networks that block port 3478 and distributed 16-person quality remain untested. See [reproduction commands](TESTING.md#external-relay-verification). VPN-free site access was explicitly deferred by the operator while choosing another host.
