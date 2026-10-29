# Runflare trial — 29 October 2026

Historical checkpoint: the operator completed Ninecraft verification and subsequently purchased the one-month Iranian VPS pilot. The new web/SFU/Windows deployment and current acceptance results are documented in [NINECRAFT.md](NINECRAFT.md). Runflare was not upgraded and its support was not contacted.

The operator selected Runflare for a VPN-free trial. Botkeep remains intact; its accounts and conversation database have **not** been imported into this trial. No paid plan has been activated.

Trial URL: https://dorham-3z7-trial.runflare.cloud/

## Actual allocation and configuration

- Fanhab Iran trial: 512 MB RAM, 0.5 GHz CPU and 1 GB storage in the account dashboard. These are smaller than the public free-plan advertisement; use the actual dashboard limits.
- Node 24.22.1, one backend, port 3000 on `0.0.0.0`.
- A 512 MB persistent volume is attached at `/app/data`; `DATA_DIR` points there.
- HTTPS, secure cookies and exact allowed web/native origins are configured. The temporary hostname's Socket.IO route is enabled.
- The compiled bundle from source `9e34a85` is installed as deployment v1. The provider's dependency scan reported zero advisories, and native SQLite loaded successfully.
- ExpressTURN credentials are in private provider Secrets, referenced from runtime environment variables. They are absent from the uploaded ZIP.

Runflare's [free-plan description](https://runflare.com/free-cloud-hosting/) and [terms](https://runflare.com/docs/terms/) describe a three-month trial with no provider backups and deletion at expiry. Keep independent backups and upgrade or migrate before expiry. Do not treat trial storage as the only copy of important data.

## Verification

| Capability | State | Evidence / limit |
| --- | --- | --- |
| Trusted HTTPS without VPN on the operator's PC | Tested | Public hostname, certificate validation and API responses |
| Registration/login, channel chat | Tested | Own test accounts; committed messages received by another authenticated socket |
| Message retry deduplication and edit replay | Tested | Native HTTP/socket integration through the public origin |
| WebSocket and explicit polling transports | Tested | Both connected and acknowledged actions |
| Voice membership visible before joining | Tested | Authorized observer bootstrap includes the other participant |
| Avatar upload/re-encoding/serving | Tested | Generated PNG fixture served as WebP |
| Persistence after manual recovery | Tested | Previous message and avatar hash survived two stopped-service recoveries; API, WSS and polling checks passed again. |
| Automatic restart recovery | Blocked | Rolling replacement conflicts with directory ownership. A stale numeric PID receipt survives shutdown and blocks the replacement with the same PID. Direct Node launch settings were rejected with `not found` while stopped; the change was not applied. |
| Forced external relay voice/screen sharing without VPN | Failed | Both ExpressTURN transports time out; no decoded media or relay candidates. Account credentials were checked against the backend-issued values. |
| Alternative TLS relay | Connectivity tested only | Metered standard endpoint on 443 returned a TURN authentication challenge over verified TLS; no account, allocation or decoded media accepted |
| Windows against Runflare | Untested | Existing installer supports entering another server address; packaged default still points to Botkeep |
| Physical Android and cross-network calls | Untested | No new device or remote-peer acceptance |
| Production data migration, sustained capacity, restore | Untested | Botkeep data preserved; no production cutover |

Logs and sanitized measurements are in `artifacts/evidence/runflare-*` and `artifacts/logs/runflare-*`. The failed two-Chrome media attempt peaked at 1200.7 MiB total measured browser memory; the 4 GiB guard did not trigger. The runtime receipt recorded approximately 101 MiB RSS at initial startup; this is not a peak/load measurement. Message acknowledgements of approximately 113–268 ms are individual functional samples, not p95 load results.

Recovery preserved both stale lock receipts by renaming them only after the dashboard showed stopped with no pods; database, WAL, SHM and avatars were untouched. The temporary authenticated volume file manager was disabled afterwards. The service is running again. Before accepting production migration, replace the container-unsafe ownership guard, ensure a single backend owns the volume during replacement, and verify graceful and abrupt shutdown/restart with decoded-media reconnection and database persistence. Do not remove a live owner's lock or treat the manual recovery as automatic restart acceptance.

## Desired relay fallback

The operator prefers a foreign relay first, then an Iranian relay if it fails. This is **planned, not implemented or tested**. Browser WebRTC supports changing the ICE server configuration and restarting ICE, but an unordered list of servers does not enforce this priority.

Implementation needs separately configured provider credentials, bounded failure detection/retries, room signaling during ICE restart, visible reconnect status and platform-specific verification. An Iranian relay must be provisioned before decoded-media fallback can be validated. No verifiable free public Iranian TURN service was found in the current research. Self-hosted [Coturn](https://github.com/coturn/coturn) is free software; an Iranian VPS, public networking, permitted relay workload and traffic allowance are still required. Runflare's restriction on proxy/tunneling workloads means a TURN process must not be assumed permitted there without provider clarification. No support message has been sent.

Keeping both the web/backend and relay reachable within Iran could support domestic calls when international connectivity is unavailable. That is conditional on domestic routing, DNS, certificates and both users' access; it cannot preserve calls to a disconnected overseas peer. A foreign relay that works with VPN off today does not establish domestic-only availability.

## Revised hosting and media requirements — 29 October 2026

The operator subsequently reported that the trial worked for about an hour and requested permanent hosting, later setting a ceiling of 400,000 toman/month. Expected use is 4–12 people for about six hours daily, usually with 1–2 screen publishers. Keep the 16-person room membership limit; remove the old fixed two-per-room/five-global publisher caps. Local source now defaults both publisher caps to zero (disabled), retaining one publication per account, authorization and lease expiry. Six-publisher integration and 20-publisher control-plane load tests pass. Existing deployments still require their environment values changed; sustained media capacity is untested.

The final clarified preference is **one Iranian VPS for the web application, database, control API and self-hosted LiveKit SFU**. The operator initially described foreign infrastructure, then clarified that this meant free foreign TURN, not a second paid server. After the distinction between mesh/TURN and SFU was explained, the operator selected the best server-based approach. Use LiveKit's integrated locally hosted TURN fallback where required; do not promise that an SFU eliminates all need for TURN on restricted client networks. A separate foreign TURN account is not required by this design. The earlier foreign-SFU-primary proposal is superseded.

An Iranian room must not depend on external STUN, foreign TURN credential issuance, a foreign SFU API or remote web assets to join. Domestic DNS and valid HTTPS certificates must also remain usable. Participants abroad cannot be reached across an unavailable international link. The requested Python-style WebSocket emergency transport and room administrator switch were discussed as an alternative; they are not implemented, and are not needed merely because the clients cannot reach foreign TURN if the Iranian SFU and its own fallback are reachable. Revisit an additional WebSocket media mode only if measured failures justify it. No room setting or additional provider has been activated.

The existing LiveKit adapter and credential service support one instance-wide SFU endpoint, but decoded-media SFU acceptance remains pending. Budget applies to one Iranian host, around 300,000 toman/month with a possible increase to discuss; do not buy a foreign SFU. No provider account, paid subscription, support message or order was submitted during this comparison.

### Hosting comparison

- [Ninecraft](https://9craft.ir/vps/): live public selection showed 348,000 toman/month, 1 vCPU, 2 GB RAM, 20 GB enterprise HDD and 120 GB incoming traffic. Its expanded FAQ says outgoing traffic is free; quota exhaustion disconnects networking until traffic is purchased or the service renewed. Additional traffic is advertised at 1,250,000 toman/TB in the Ninecraft region and 950,000 toman/TB in Hiweb. Available checkout inventory, final account quote, permitted SFU/TURN workload and actual UDP connectivity remain unverified. This is a plausible backup/pilot candidate, not accepted full-workload capacity.
- [Avesta](https://avestahost.com/iran-vps/): 349,000 toman (1 core/2 GB) and 399,000 toman (2 cores/2 GB) advertised with 20 TB; the live browser rendered the plans as unavailable. Excluded from immediate deployment.
- [Bia2Host](https://bia2host.com/iran-vps/): the 2-core/2 GB unlimited plan advertises 490,000 toman base. A real monthly cart quote with Ubuntu 24.04 and 5 Mbps international incoming bandwidth was 12,050,000 rial = 1,205,000 toman. The option adds 143,000 toman per Mbps. The temporary single cart item was removed and an empty cart verified; no checkout/order/payment was submitted. Screenshot: `artifacts/evidence/bia2host-5mbps-quote.png`. This exceeds the discussed budget.
- Penta was skipped at the operator's request after conflicting economy-stock indications. Other cheap listings whose purchase portals were broken were not treated as available offers.

At the current 1.2 Mbps 720p target, six hours/day over 30 days is approximately 97.2 GB incoming per continuously published screen, or 194.4 GB for two, before voice and overhead. This is a sizing calculation, not a usage measurement. SFU outgoing traffic grows with subscriptions. The [LiveKit Cloud free plan](https://livekit.com/pricing) advertises 5,000 participant minutes and 50 GB downstream; that is not enough for the described daily workload. No free-plan activation or billing setup occurred.

### Old messenger inspection and UI follow-up

Read-only inspection of `E:/Godot/Apps_and_Projects/Messenger_App/Backends/messanger_python_BE` found server-forwarded binary WebSocket media: `client/scripts/VoiceManager.gd` captures mono 16-bit PCM at a 16,000 Hz target, GZIP-compresses it and sends binary packets; `server/routers/ws.py:252` forwards audio packets to room peers and JPEG packets to screen viewers. `client/scripts/GroupScreen.gd:1056` uses a 0.2-second screen timer and sends JPEG at quality 0.4, resizing wider captures to 1280x720. Despite retained WebRTC names/signaling, this code path makes the application backend itself a media relay. Inspection explains the architecture; it does not verify that the old deployment is presently reachable or prove its historical outage behavior. The old project was not modified.

Local UI follow-up is implemented, not deployed: incoming mesh audio is metered before playback gain with a lower activity threshold and short hold, driving a green avatar outline. A real two-client decoded-audio test passed quiet activity, silence, mute/unmute and independence from playback volume. Screen viewing now takes priority over chat, with a saved opt-out and mobile layout. The initial regression passed; a later rerun passed the existing WebRTC scenario, then the memory guard stopped the suite before the remaining checks completed. The added decoded-video screenshot assertion needs another guarded run when memory permits. Twenty unit/integration tests, lint/type checking and production API/web/desktop builds passed. No installer or deployed instance has received these changes.

### Paid-plan attempt and selected pilot

Runflare's existing account showed 50,000 toman credit. The operator authorized trying the advertised 310,000-toman paid application plan with that credit. Package loading failed in the existing project's upgrade view and in new-project flows for both Respina IRAN and Pishgaman IRAN. The final submit remained disabled; no paid order, charge or new project was created. The operator explicitly declined contacting Runflare support. A NodePort option was visible in the network form, but public UDP/raw TCP support was not established; the unsubmitted form was cancelled without changing networking. Runflare's separate Iranian VPS product starts at 720,000 toman and exceeds the ceiling.

Additional checks rejected Caspian's advertised 400,000-toman plan because its CRM displayed maintenance, and EMD's 390,000-toman offer provides only 1 GB RAM/250 GB traffic, with no accepted full-workload evidence. No new support messages were sent.

The operator selected **Ninecraft for a one-month pilot at 348,000 toman, with traffic monitoring and reduced screen bitrate** after the 120 GB incoming allowance was explained. This authorizes the pilot, not an unbounded traffic top-up or a claim that the full six-hour daily workload fits. The logged-in VPS dashboard disables creation until national-ID verification and also requests phone verification. The account page is open for the operator, who said they will complete verification and report back. No national ID/code was collected by the agent; no Ninecraft order, wallet charge, server or SFU was created. Its dashboard also warns that international connectivity can be unstable in some cases.

Next, after the operator reports verification complete: inspect the actual one-month order with no add-ons and its final total, then provision the authorized pilot if it fits the ceiling and terms/networking permit the workload. Prepare the Iranian LiveKit/TURN host and reduced publishing settings, add real interface traffic measurements and quota alerts, and validate decoded audio/video from independent networks. Preserve Botkeep data and backups until migration acceptance. Reduced bitrate, traffic monitoring and the new SFU are still pending implementation/configuration.
