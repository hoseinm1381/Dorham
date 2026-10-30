# Dorham usability reliability and resource audit

30 October 2026, Tehran. Audited release 0.4.4, source commit `8faaf02f3a5eaba5fe4bee3402093fc8f52c90ec`.

Dorham is a functional private beta. It already has substantial foundations: authorized persistent chat, invitations, roles, recovery codes, guests, uploads, inline media, self-hosted voice, screen sharing, Persian support and a Windows client. Its next release should concentrate on reliability and everyday workflow. A saved permission denial can currently be erased by the editor, proxy clients share rate-limit buckets, unsent drafts disappear on navigation, and unread state advances past unseen messages. These are more consequential than adding another decorative feature.

The 16-person room limit is an admission policy, not a demonstrated media capacity. The earlier ten-user/four-screen test failed; no subsequent release has closed that gate. The Iranian host also still uses temporary foreign-dependent DNS. Domestic-only availability remains an infrastructure acceptance task.

This audit proposes changes; it does not apply them. Production accounts, permissions, quotas and services were left intact. Android remains deferred.

## Evidence and scope

Fresh checks for this audit:

- All **66 existing unit/API tests passed**. This is useful baseline coverage, but those tests did not catch the newly reproduced UI failures.
- An isolated browser scenario reproduced **three current defects** against a real local database/API and the production frontend: saved permission loss, draft loss and premature read acknowledgement.
- A separate isolated API test reproduced shared rate-limit buckets with the default limiter enabled. No flood was sent to production.
- `npm audit` reported **zero known advisories**, both with production-only selection and across the complete installed dependency graph. This does not establish the absence of application vulnerabilities, malicious packages or native/OS issues.
- The live website returned 200; readiness passed; unauthenticated bootstrap returned 401. TLS 1.3 and the current certificate were verified. Dorham, LiveKit, Caddy and HAProxy were active.
- A quiet VPS snapshot showed about **1,465 MiB available RAM**, 18% root filesystem use and no configured swap. Dorham RSS was about **130 MiB** and LiveKit RSS about **86 MiB**. The process CPU values in the snapshot are lifetime averages, not a load benchmark.
- The browser audit peaked at **2,176.8 MiB combined browser memory**, including existing browser processes, and **1,057 MiB owned browser memory**. The normal 4 GiB guard remained active and did not stop the run. These figures are test-harness totals, not a per-user application memory benchmark.
- Both local test accounts and their fixture conversations were deleted afterward. Database integrity and foreign keys passed. No production test account was created.

The audit covered source and contracts, production UI workflows, existing media/load evidence, dependencies, operational configuration and official comparison documentation. It did not repeat heavy media capacity tests, physical headset/Bluetooth tests, a six-hour soak, a real domestic internet outage, Android testing or an exhaustive penetration test. Findings explicitly distinguish reproduced behavior, source findings and unresolved verification gates.

## Defects and architectural findings

### Saved permissions can be accidentally removed

**High severity, reproduced.** Save a member-role `write=false` override, reopen the permissions editor, and its control displays the default rather than the saved denial. Saving the unchanged form replaces the entire permission object with the blank object, restoring permission. This is an administrative correctness bug that can grant access accidentally; it is not a demonstrated unauthenticated exploit.

The test observed `actualBefore=false`, `displayedControl=""`, `actualAfterSavingUnchangedUI=true`. Channel/role changes also do not reload a separate saved override model. The same replacement path handles the other permission fields, so the fix must cover all fields and channel/role switching, not just messaging.

Evidence: [permission editor](/D:/Dorham/apps/web/src/App.tsx:234), [replacement write](/D:/Dorham/apps/api/src/service.ts:142), [browser observations](/D:/Dorham/artifacts/evidence/audit-0.4.4-probes.json).

Required change: return the editable override document, hydrate it for the selected channel and role, show effective permissions separately, and save deliberate changes with a concurrency/version guard. Add reopen/save/switch and two-admin regression tests.

### Rate limits do not distinguish clients behind the proxy

**High availability impact, reproduced locally.** Fastify uses `trustProxy:false`; the rate limiter defaults to the connection IP. The loopback reverse-proxy architecture therefore puts users into shared buckets. The authentication route allows 60 attempts per 15 minutes. After one simulated client consumed that allowance, another forwarded client through the same connection address received 429. Changing the actual connection address returned 401 as expected.

Evidence: [API configuration](/D:/Dorham/apps/api/src/app.ts:30), [authentication limiter](/D:/Dorham/apps/api/src/app.ts:112), [isolated result](/D:/Dorham/artifacts/evidence/audit-0.4.4-ratelimit.json).

Required change: trust only the known proxy path, ensure that proxy overwrites client-supplied forwarding headers, restrict direct backend ingress, and layer account/session and source-address limits. Do not solve this with unrestricted `trustProxy:true`, or remove abuse limits. Validate multiple clients through the real proxy and spoofed forwarding headers in an isolated environment.

### Navigation destroys unsent drafts

**High everyday impact, reproduced.** Type in general, switch to another channel, and return: the composer is empty. Conversation changes reset draft, reply/edit context and pending attachments. Uploaded unsent attachments may consume quota even after the user loses the corresponding draft.

Evidence: [conversation change effect](/D:/Dorham/apps/web/src/App.tsx:169), [observations](/D:/Dorham/artifacts/evidence/audit-0.4.4-probes.json).

Use bounded per-account/per-server/per-conversation drafts. Keep them in memory first; make local persistence explicit, clear it on sign-out, and never silently send queued content. Do not cache private chat history in the public service worker to implement drafts.

### Read state advances past unseen messages

**High everyday impact, reproduced.** While the reader remained at scroll position zero in a 4,208px history with a 596px viewport, a new message at the bottom advanced their read cursor to sequence 35. Visibility alone is treated as reading. The implementation also does not require the window to have focus.

Evidence: [read update and event handling](/D:/Dorham/apps/web/src/App.tsx:110), [observations](/D:/Dorham/artifacts/evidence/audit-0.4.4-probes.json).

Read only the highest actually visible message while the window is focused. Add an unread divider, a new-message counter and Jump to latest. Batch/coalesce cursor writes rather than sending a mutation for every received edit or reaction. Keep event replay sequence separate from unread message counts.

### The media capacity gate is still failed

**Release gate, historical measured failure.** The prior ten-client/four-share scenario did not achieve a verified five-minute hold. Its isolated-control-plane comparison retained ten members and 90 audio subscriptions with energy, decoded up to 34 of 36 expected screen subscriptions, and ended with about 18.84% aggregate received video packet loss. It stopped at roughly 5.24 GiB total browser memory under that run's explicitly authorized 6 GiB allowance.

Evidence: [capacity report](/D:/Dorham/artifacts/evidence/optimization-stress-summary.json), [optimization scope](/D:/Dorham/docs/OPTIMIZATION-0.4.1.md).

This does not isolate CPU, server uplink, client decoding, congestion, VPN or transport as the sole cause. Use independent devices and networks, identify selected ICE transport, compare UDP with the existing domestic TURN/TLS, and measure decoded video/audio plus loss and acknowledgements. Start with the usual 4–12 users and 1–2 screens, then test ten users/four screens and sixteen users. Do not repeat the heavy all-on-one-laptop test casually or purchase a larger server based only on this failure.

### Screen quality labels are misleading under the pilot policy

**Source and live configuration finding.** The UI offers 15/30fps labels, while live publishing is capped at **12fps and 450 kbps**. The separate policy notice explains this, but the preset label still implies a result that cannot be delivered. The 720p30 mode and 720p15 mode both hit the same server ceiling. Four-share testing is also unlike four full-rate 1080p streams.

Evidence: [preset calculation](/D:/Dorham/packages/media/src/screen-quality.ts:3), [diagnostic options](/D:/Dorham/apps/web/src/App.tsx:222), [live policy snapshot](/D:/Dorham/artifacts/evidence/audit-0.4.4-live.json).

Show actual effective limits beside the selected preset and distinguish requested quality from measured delivery. Offer Text, Balanced and Motion presets only when their actual capture/bitrate behavior differs.

### Screen sharing currently has no sound

**Source finding.** The LiveKit share path explicitly requests `audio:false`, the Windows source callback returns video only, and SFU publishing grants permit microphone and screen video, not screen audio. Adding a checkbox alone would not implement the feature.

Evidence: [screen capture](/D:/Dorham/packages/media/src/livekit.ts:127), [SFU source permissions](/D:/Dorham/apps/api/src/sfu.ts:21), [Windows capture picker](/D:/Dorham/apps/desktop/main.cjs:28).

Implement optional capture of supported tab/system audio, separate stream-audio volume, publish/grant/revocation parity and clear platform limitations. Never include loopback audio by default without a deliberate choice. Browser/OS capability and physical echo behavior need testing.

### Adaptive video exists but does not solve every receiver budget

**Source finding.** LiveKit already enables adaptive streaming and dynacast, and remote videos use the SDK attach method. Those are good foundations. Screens use one VP8 encoding with `simulcast:false`, however, and the app has no explicit low-data mode or one-focused-stream receive budget. The initial connection uses default subscription behavior; manual unsubscribe is available afterward.

Evidence: [transport options](/D:/Dorham/packages/media/src/livekit.ts:11), [subscription controls](/D:/Dorham/packages/media/src/livekit.ts:136), [LiveKit adaptive-stream documentation](https://docs.livekit.io/transport/media/subscribe/).

Default a constrained receiver to one selected screen, with explicit opt-in to more. Preserve the user's request to allow multiple publishers; control each viewer's receive workload instead of reinstating a fixed publisher cap. Benchmark simulcast as an option because extra encodings add publisher CPU/upload. Merely setting dynacast does not create multiple layers. [LiveKit codec and simulcast documentation](https://docs.livekit.io/transport/media/advanced/).

### Audio setup is incomplete for everyday devices

**Source finding.** Browser/Windows have microphone selection and processing controls, but no speaker/output selector and no app device-change handling. Individual volume values reset with the media transport. A disconnected headset can therefore require the user to diagnose the route manually. The recent volume/deafen repairs already have synthetic decoded-audio tests; this audit does not reclassify them as broken.

Add a pre-call mic meter, a speaker test, output selection where supported, device hot-plug handling and saved per-person volume. Keep preflight optional for repeat joins. Physical echo cancellation and Bluetooth switching still need real hardware acceptance. Meet's pre-join device check is a useful model. [Google Meet device checks](https://support.google.com/meet/answer/10409699?hl=en).

### History rendering can lose the reader and do excess work

**Source finding.** Older pages append without a virtualized window; live message handling then slices the in-memory list to the newest 200. Reading a large loaded history while new events arrive can therefore discard previously loaded rows. Every row also resolves authors through a linear users search during a large App render. Actual user-facing scroll movement from this path was not separately reproduced in this audit.

Evidence: [history loading](/D:/Dorham/apps/web/src/App.tsx:99), [event window](/D:/Dorham/apps/web/src/App.tsx:117), [message rendering](/D:/Dorham/apps/web/src/App.tsx:218).

Keep stable scroll anchors, a bounded virtualized history, a map for authors and memoized message rows. Test new edits, image expansion, prepended history and incoming messages while reading old content. A giant rewrite is unnecessary; split the working component incrementally.

### Network failures need useful states

**Source finding.** The shared HTTP client has no explicit fetch deadline, and the composer has no durable pending/failed message model. Idempotent retry protection exists and should be preserved. An ambiguous timeout should retain its request ID so retry cannot duplicate a committed message. Late send completion must not clear a different conversation's newer draft.

Evidence: [HTTP client](/D:/Dorham/apps/web/src/api.ts:28), [send workflow](/D:/Dorham/apps/web/src/App.tsx:182).

Show Connecting, Sending, Failed, Retry and Cancel with clear distinction between offline, session expiry, rate limit, storage/full quota and media failure. An offline cached shell currently reaches a login-looking state; it should clearly identify connectivity loss rather than imply that credentials are wrong.

### Files can be more efficient without a transcoding service

**Source finding.** Inline media is authorized, supports byte ranges, lazy visibility, no-store, bounded readers and controlled MIME signatures. Those protections should remain. Image previews still use full original media; there is no derivative thumbnail pipeline. On the server, a cold media check hashes the entire file before serving it and caches that result for 60 seconds; concurrent cold requests can repeat that work. Video/audio-only codec compatibility is not implied by an MP4 extension.

Evidence: [attachment presentation](/D:/Dorham/apps/web/src/AttachmentMedia.tsx:14), [cold hash and delivery](/D:/Dorham/apps/api/src/attachment-media.ts:63).

Generate small authorized image thumbnails once during upload, retain the original for download, coalesce cold integrity work, and explain unsupported codecs. These changes can save transfer and decoder memory. Video transcoding would be much more expensive and should stay out of the baseline 1-vCPU server.

### Accessibility and Persian support need another pass

**Source findings and verification gaps.** Many icons already have labels; message actions support focus-within; Persian fonts are bundled; bidi and IME have tests. Still, the global modal's manual focus list includes disabled controls and controls inside collapsed details, and the background is not made inert. A screen-reader/keyboard acceptance pass is needed before treating this as accessible. Many secondary labels are tiny and some touch controls are only 19–30px. No reduced-motion media rule was found.

The home people search uses Persian normalization, while the Find people dialog uses plain lowercase matching. Typing equivalent Arabic/Persian letter forms can therefore behave differently between the two places. Some dynamic English labels, native picker strings and voice volume labels bypass translation.

Evidence: [modal](/D:/Dorham/apps/web/src/App.tsx:33), [two search paths](/D:/Dorham/apps/web/src/App.tsx:218), [people dialog](/D:/Dorham/apps/web/src/App.tsx:222), [Windows strings](/D:/Dorham/apps/desktop/main.cjs:28).

### Operations and packaging are still pilot grade

**Verified state and source findings.** The temporary web/voice/TURN hostnames depend on nip.io; a real Iran-only outage has not been tested. Release backups exist and previous restore checks exist, but the inspected timers did not list a recurring Dorham data-backup job. This inspection does not certify provider/cron backup schedules. A backup stored only on the VPS does not protect against losing that VPS.

Readiness currently checks the database, not complete call readiness. Existing minute-by-minute traffic monitoring warns but neither buys traffic nor stops calls. Its provider reconciliation is still essential. The Windows package remains unsigned and has no installed updater; its source picker uses a text dialog with the first 18 sources and no thumbnails. Renderer background throttling is disabled globally, including when idle.

Evidence: [readiness](/D:/Dorham/apps/api/src/app.ts:110), [traffic monitor](/D:/Dorham/deployment/traffic-monitor.py), [Windows shell](/D:/Dorham/apps/desktop/main.cjs:42), [operational snapshot](/D:/Dorham/artifacts/evidence/audit-0.4.4-live.json).

Documentation also mixes current and historical assertions: STATUS contains an old capability table marking external LiveKit as blocked, while the pilot now runs it, and README retains a rejoin-only audio processing explanation after live application was implemented. Consolidate the current matrix and put old results in a dated history section.

## Resource budget

The following are arithmetic scenarios, not measured billing forecasts. They assume each screen continuously reaches its configured 450 kbps ceiling for six hours/day over 30 days. Actual variable bitrate can be lower. Protocol overhead, reconnects and retransmissions increase traffic, while idle suppression and subscriptions can lower it. GB here is decimal, matching the nominal 120 GB allowance; application MiB/GiB quotas are binary.

`screen incoming GB = screens × 0.45 Mbps × 3,600 × 6 × 30 ÷ 8 ÷ 1,000`

| Scenario | Screen traffic into the VPS | Screen traffic out of the VPS |
| --- | --- | --- |
| 1 continuous screen, 4–12 people | 36.45 GB/month | 109.35–400.95 GB/month if everyone else watches |
| 2 continuous screens, 4–12 people | 72.90 GB/month | 218.70–801.90 GB/month if all other participants watch each screen |
| 4 continuous screens, 10 people | 145.80 GB/month | 1,312.20 GB/month if all other participants watch each screen |

Four screens are permitted on demand; the last row demonstrates why four sustained daily publishers cannot fit the nominal incoming allowance at that rate. It does not mean four brief shares consume a month of traffic. Provider rules, measurement and actual network throughput remain authoritative.

The 450 kbps setting is an official-client encoder policy, not a server billing firewall. A modified client is not guaranteed to respect it. Any operator-enforced ingress budget needs separate SFU/network validation and a clear user policy; silently cutting ongoing calls is not the proposed default.

At 24 kbps, one continuously publishing microphone adds approximately **1.944 GB/month** over the same hours. Four to twelve continuously transmitting microphones would add roughly **7.78–23.33 GB incoming**, before overhead; discontinuous transmission normally reduces silence. The 1 GiB/day instance upload ceiling could additionally allow **32.21 GB over 30 days**. Together, two screens plus maximum uploads plus those hypothetical microphones reach roughly **112.9–128.4 GB**, before overhead. This is a reason to expose budget pressure and offer receive/capture presets, not to promise the current plan fits every day of that workload.

Server forwarding multiplies outgoing traffic. It does not normally multiply a screen publisher's incoming upload by the number of viewers. Watching one instead of four equal-rate screens reduces that viewer's screen-video traffic by about **75%**, and reduces SFU outgoing traffic for that viewer; it does not itself cut the publisher's incoming traffic while others continue watching. Client CPU/RAM savings cannot be inferred as the same percentage.

The current main JS file is **1,092,988 raw bytes**; an offline gzip calculation produces **302,293 bytes**. CSS is 54,717 raw bytes and the local Persian font is 111,152 bytes. This describes the build, not actual HTTP compression. Lazy-loading media/settings can reduce initial parsing and transfer on first use, but may have little effect on steady active-call memory. Keep offline precaching compatible with code splitting.

### Cost labels used below

- **Tiny:** event-driven UI or a few bounded rows/values; no extra continuous media. No meaningful ongoing cost expected at 20 users, but not literally zero work.
- **Low:** bounded client storage, light database queries or occasional jobs. Appropriate for the present stack if implemented carefully.
- **Medium:** new indexes, periodic media sampling, derivative files or extra background activity; measure CPU/RAM/disk before enabling broadly.
- **High:** additional real-time encoding/decoding, video processing, speech models or recording. Material effect on the current server or clients.
- **Saves:** expected reduction in a named resource. The amount remains unmeasured unless an arithmetic example is given above.

These labels are engineering estimates. Exact extra MiB or CPU percentages would be invented until the feature is built and profiled. Separate client CPU/RAM, server CPU/RAM, network traffic and storage in acceptance reports.

## Ranked improvement backlog

P0 means fix the risk or close the acceptance gate first. P1 means high-value everyday reliability. P2 means useful productivity and polish. P3 means optional work with a weaker benefit/cost fit. IDs identify recommendations, not implementation order within the same priority.

### Correctness and message reliability

| ID | Priority | Improvement and user benefit | Resource effect |
| --- | --- | --- | --- |
| 01 | P0 | Load and safely edit saved permission overrides; never grant access by saving an unchanged form. | Tiny client state and one small read on selection; no media impact. |
| 02 | P0 | Repair proxy-aware rate limits; prevent one person locking out everyone. | Low server bookkeeping; retains abuse protection and can reduce wasted hash CPU. |
| 03 | P0 | Turn the four reproduced failures into lasting regression tests, including real proxy behavior. | Development/CI cost only; no production runtime cost. |
| 04 | P1 | Preserve per-conversation drafts, reply context and attachment state with clear expiry. | Low client RAM/storage; propose a bounded 1 MiB serialized-text budget, not unlimited history. |
| 05 | P1 | Read only visible messages; add unread divider, new-message count and jump to latest. | Tiny/low client observation; coalesced cursors can save server writes and socket work. |
| 06 | P1 | Pending/failed/sent message states and explicit retry using the same idempotency ID. | Low bounded client state; fewer accidental duplicates and reloads. |
| 07 | P1 | HTTP deadlines, cancellation and specific offline/rate/quota/session errors. | Tiny; can release stuck requests and prevent retry storms. |
| 08 | P1 | Fence late async responses by account/conversation; prevent a slow send clearing a newer draft. | Tiny bookkeeping; no persistent media or storage cost. |
| 09 | P1 | Confirm destructive message/moderation actions and offer safe undo where policy permits. | Tiny for confirmation; low bounded server state if delayed deletion/undo is chosen. |
| 10 | P1 | Stable scroll anchors and virtualized, bounded history. | Medium implementation complexity; saves client DOM memory and rerender CPU. |

### Voice and screen sharing

| ID | Priority | Improvement and user benefit | Resource effect |
| --- | --- | --- | --- |
| 11 | P0 | Distributed decoded-media capacity and recovery tests, starting at usual usage. | Test bandwidth/client CPU; no recurring application overhead. Do not run all encoders on this laptop. |
| 12 | P1 | Optional pre-call mic meter, speaker test and processing preview. | Low client CPU while open; stop test tracks and timers when closed. No server media needed for a local check. |
| 13 | P1 | Speaker/headset output selector with honest browser support. | Tiny/low client cost; no extra server stream. |
| 14 | P1 | Detect device removal/Bluetooth changes, explain fallback and restore selected routes. | Tiny event listeners; short capture restart cost when needed. |
| 15 | P1 | Low-data/audio-only/one-screen receive modes and explicit opt-in to extra streams. | Saves viewer bandwidth and decoding CPU/RAM, plus SFU outgoing traffic; not automatically publisher incoming traffic. |
| 16 | P1 | Separate chat status from media health; show loss, media RTT and “no sound/video received” guidance. | Low/medium bounded RTC sampling during calls; avoid permanent full-stat polling. |
| 17 | P1 | Show actual effective screen bitrate/fps; use distinct Text/Balanced/Motion modes. | Tiny UI cost; lower capture settings can save publisher CPU/upload. Higher modes cost more. |
| 18 | P1 | Pin one shared screen prominently and make other shares selectable; retain multi-view. | Tiny layout state; can save decoding if inactive shares really unsubscribe. |
| 19 | P2 | Pan/zoom/fit/actual-size controls for screen text and images. | Low client rendering/GPU; no new server stream. |
| 20 | P2 | Drag to resize the screen/chat split, with saved accessible keyboard control. | Tiny local state; no media cost unless bigger tiles trigger higher receive layers. |
| 21 | P2 | Picture-in-picture or a pop-out viewer with optional always-on-top in Windows. | Low/medium extra window/GPU overhead. Move/reuse a track; do not duplicate subscriptions. |
| 22 | P1 | Optional tab/system audio with a separate stream-audio level and permission enforcement. | Low/medium client capture/Opus CPU; extra audio bandwidth/server forwarding for every subscriber. |
| 23 | P2 | Switch the shared window, pause/resume capture and show a stronger source preview. | Low ongoing cost; restarting capture costs a short burst. Pause should stop outgoing frames. |
| 24 | P1 | Remember per-person volume/local mute, with independent notification/master levels. | Tiny bounded local preferences; gain changes add no new network traffic. |
| 25 | P3 | Optional stronger local noise suppression after measuring the built-in processing. | Medium/high client CPU/model RAM, depending on implementation. Keep off by default on weak devices; no cloud requirement. |

### Chat and attachments

| ID | Priority | Improvement and user benefit | Resource effect |
| --- | --- | --- | --- |
| 26 | P1 | Authorized message search by text, person, date, channel and attachment type. | Low/medium server CPU/disk for SQLite full-text indexing; bounded results. No separate search cluster needed at 50k messages. |
| 27 | P1 | Copy message link and jump directly to a message or reply target. | Tiny/low indexed query plus existing permission checks; no media cost. |
| 28 | P1 | Real @user mentions and restrained autocomplete; permission-control mass mentions. | Low parsing and a few indexed rows/events; text alone is not a notification system. |
| 29 | P1 | Unified unread/mentions inbox, accurate counts and mark-unread controls. | Low indexed reads/storage; batch updates rather than poll every channel. |
| 30 | P1 | Per-channel/server/DM notification modes and temporary mute. | Tiny preferences; filtering can reduce sounds and notification work. |
| 31 | P1 | Opt-in Windows/browser notifications, taskbar badges and private preview controls. | Low event-driven overhead. Web push needs platform infrastructure and may fail in Iran-only conditions; in-app/Electron notifications can work while connected. |
| 32 | P2 | Pinned messages and personal bookmarks. | Tiny/low metadata queries. Pins must not silently promise exemption from retention or attachment expiry. |
| 33 | P2 | Safe formatting: code blocks, inline code, quotes, spoiler text and copy code. | Low client parse work; use a constrained renderer and no raw HTML. |
| 34 | P2 | Expose a reaction picker rather than only the thumbs-up shortcut. | Tiny client UI with the existing six allowed reactions; arbitrary emoji requires contract changes. |
| 35 | P2 | Drag/drop attachments, multi-file staging and clearer removal/caption UX. | Tiny until upload; existing upload/compression costs still apply. |
| 36 | P2 | Upload/download progress, cancellation and useful retry; show quota reset behavior. | Low client progress events/state. Resumable uploads add disk/state complexity and should be separate. |
| 37 | P1 | Authorized image thumbnails and coalesced integrity checks. | Medium one-time image CPU plus bounded thumbnail disk; saves repeated transfer, disk reads and client image RAM. |
| 38 | P2 | Image gallery with zoom, next/previous and keyboard navigation. | Low client state; decode only nearby images to avoid a large RAM increase. |
| 39 | P2 | Codec/expired-file explanations and safe download fallback. | Tiny capability checks; no server transcoder required. |
| 40 | P2 | Lightweight threads so active discussions do not bury the main conversation. | Low/medium extra rows, unread state and queries; reuse bounded history and existing authorization. |

### Navigation accessibility and Persian

| ID | Priority | Improvement and user benefit | Resource effect |
| --- | --- | --- | --- |
| 41 | P2 | Ctrl+K quick switcher for servers, channels and people. | Low client search over the already loaded small directory; no permanent background job. |
| 42 | P2 | Discoverable shortcuts, message keyboard actions and configurable Enter-to-send. | Tiny keyboard/state logic; keep PTT safety and IME composition behavior intact. |
| 43 | P1 | Complete Persian normalization/translation in every search, dynamic label and Windows dialog. | Tiny CPU and translation bytes; bundled font already exists. |
| 44 | P2 | Text scaling, density, stronger contrast and reduced motion. | Tiny CSS/settings; fewer animations can save CPU/GPU and battery. |
| 45 | P1 | Robust dialogs, focus restoration/inert background and screen-reader status messages. | Tiny runtime work; accessibility testing is the main cost. |
| 46 | P1 | Touch-sized controls, accessible tooltips and context menus for small-screen actions. | Tiny layout/UI cost; no server impact. |
| 47 | P1 | Separate settings into Profile, Audio, Notifications, Privacy and Advanced. | Tiny component state; lazy panels may reduce initial JS work. |
| 48 | P1 | Clear invitation preview, guest/member explanation, empty states and first-call help. | Tiny/low authorized invite-preview request; avoid leaking private server details. |
| 49 | P2 | Hide completed bootstrap setup and explain unavailable administrative controls. | Tiny public capability flag/UI work; never expose the secret. |
| 50 | P2 | Restore last selected channel, conversation scroll position and per-room layout choices. | Tiny bounded local preferences; scope by account/server and clear appropriately. |

### Operations privacy and maintainability

| ID | Priority | Improvement and user benefit | Resource effect |
| --- | --- | --- | --- |
| 51 | P0 | Owned domain with domestic authoritative DNS; verify web/API/SFU/TURN and certificate lifecycle in domestic-only conditions. | Negligible ongoing app cost; DNS/domain operating cost separate. Availability still depends on host/network/policy. |
| 52 | P1 | Scheduled coordinated backups, encrypted independent copy and recurring isolated restore drills. | Low/medium temporary disk/I/O and backup transfer; choose retention and short snapshot windows deliberately. |
| 53 | P1 | Operator-visible monthly traffic projection, storage pressure and configurable safe warnings. | Low minute-scale sampling using existing counters; do not query every client every second. No automatic paid top-up. |
| 54 | P1 | Separate web/database/SFU/TURN health and sanitized incident diagnostics. | Low probes/capped logs; full RTP capture or unlimited metrics would be expensive and privacy-sensitive. |
| 55 | P1 | Reauthenticate sensitive admin actions and offer offline-capable TOTP/recovery codes. | Tiny/low server cryptography/storage; no email provider required. Maintain a safe administrator recovery path. |
| 56 | P2 | DM requests, shared-server privacy options, guest expiry/cleanup and visibility choices. | Low filtering and bounded cleanup; consider compatibility with the current instance-wide people directory. |
| 57 | P1 | Effective-permission preview, test-as-role and more granular moderation/role-management permissions. | Low extra reads/rows; cache carefully and revalidate media on permission changes. |
| 58 | P1 | Clear retention/expiry policy, authorized data export and account deletion/ownership rules. | Tiny policy UI; medium export I/O when requested. Stream exports and never include another participant's unauthorized data. |
| 59 | P1 | Trustworthy version/update notice, call-aware update deferral and eventually signed Windows updates. | Tiny idle checks; installer download is about 122 MB today. Signing may have monetary cost; no purchase implied. |
| 60 | P1 | Split App into message/voice/navigation/settings modules, memoize rows, lazy-load media, and throttle idle Windows rendering safely. | Can save startup/idle CPU/RAM; implementation/testing cost medium. Never throttle active background PTT/audio or break PWA precaching. |

### Later options with clearer costs

| ID | Priority | Improvement and user benefit | Resource effect |
| --- | --- | --- | --- |
| 61 | P2 | Better device/session names, last-used state and explicit handling of the current three-session limit. | Tiny/low rows and UI; prevent surprising silent eviction of older sessions. |
| 62 | P2 | Explicit server ownership transfer before leaving or deleting an owner account. | Tiny transactional changes/audit rows; must preserve hierarchy and require reauthentication. |
| 63 | P2 | Automatic idle, custom status, optional invisible presence and clearer busy behavior. | Low event/timer work; throttle presence transitions and avoid gathering activity outside the app. |
| 64 | P2 | Raise hand and a lightweight speaking queue for busy rooms. | Tiny socket events and bounded room state; no extra media stream. |
| 65 | P3 | Polls and scheduled community sessions. | Low database rows and reminders; timezone and notification work required. |
| 66 | P3 | Optional webcams and meeting-style participant tiles. | High client encoder/decoder work and extra VPS incoming/outgoing bandwidth. Re-establish capacity before adding this. |
| 67 | P3 | Optional call recording with explicit consent and retention. | High client or server capture/muxing CPU and disk. At 1 Mbps, one recording is about 450 MB/hour before overhead. |
| 68 | P3 | Live captions/transcription, with Persian quality acceptance. | High CPU/model RAM locally or on server, or a paid/external dependency; poor default fit for 1 vCPU/2 GB and domestic outage goals. |
| 69 | P3 | External link previews with opt-out and a sandboxed bounded fetcher. | Low/medium network/cache cost, plus SSRF/privacy complexity and external reachability dependencies. Prefer click-to-load. |
| 70 | P2 experiment | Benchmark simulcast or hardware-supported codecs for different receiver networks. | May save receiver bandwidth but increases publisher encodes/upload; AV1/VP9 may be costly without hardware. No blanket switch or promised savings. |

## Comparison with established tools

Discord provides useful references for [filtered message search](https://support.discord.com/hc/en-us/articles/115000468588-How-to-Use-Search-on-Discord), an [unread and mentions inbox](https://support.discord.com/hc/en-us/articles/360045027712-Inbox-FAQ), and [selectable multiple streams](https://support.discord.com/hc/en-us/articles/360045784891-Video-Screenshare-Updates-Multistream-and-More). Dorham already has multiple streams; the remaining opportunity is deliberate selection, focus and receive budgets.

Meet provides useful references for [pre-join device checks](https://support.google.com/meet/answer/10409699?hl=en), [pinning presentations](https://support.google.com/meet/answer/7501121?hl=en), [quality troubleshooting](https://support.google.com/meet/answer/10620583?hl=en), and [presentation viewing/audio controls](https://support.google.com/meet/answer/9308856?hl=en). The recommendation is to adopt these workflow patterns within Dorham's smaller resource budget. Product availability can vary by platform and plan; no third-party service is required to implement the corresponding local features.

## Recommended implementation order

1. **Repair the proven faults:** permission hydration/safe saves, proxy-aware rate limits, and regression coverage. Preserve live permissions and test migrations with real existing override documents.
2. **Protect conversations:** drafts, visible read cursors, pending/retry states, deadlines, async fences and stable history. These changes should make everyday use safer with little recurring resource cost.
3. **Make calls diagnosable and economical:** local preflight, speaker routing/hot-plug, effective quality labels, a focused receive budget, media health and saved audio levels. Keep the current built-in cancellation/deafen behavior covered.
4. **Close infrastructure gates in parallel:** domestic DNS/domain, backup automation/restore drill, operator traffic visibility and distributed decoded-media tests. This is necessary before promising Iran-only or sixteen-person reliability.
5. **Add the highest-value missing features:** search, message links, mentions/inbox, notification controls, screen pinning/audio and thumbnail delivery. Re-profile each media-affecting change.
6. **Polish navigation and access:** Persian consistency, settings categories, keyboard/screen-reader/touch acceptance, split layout, gallery, pins and quick switching.
7. **Consider expensive optional features only after the baseline passes:** stronger AI suppression, webcams, recording, captions and external previews. Keep them disabled by default unless there is measured headroom and a real use case.

A practical next release should contain steps 1–2 and the cheapest parts of 3. Avoid combining a permission-system correction, a media codec change and a large UI rewrite into one release; their failures would be difficult to isolate.

### Acceptance criteria

- Permission values survive reopen, unchanged save and channel/role switching. Concurrent administrator changes cannot silently overwrite each other. Lower roles still cannot gain unauthorized powers.
- Drafts survive switching and temporary disconnect; late sends cannot clear another draft; explicit retry cannot duplicate committed messages. No implicit auto-send on reconnection.
- Read cursors follow visible/focused messages, preserve unread items while scrolled up, and do not write on every unrelated reaction.
- Calls recover from device removal and network interruption with visible, bounded states. Audio/deafen/PTT safety holds through capture restarts, background/tray use and helper failure.
- Distributed tests assert actual decoded media, not only joined participants or received packets. Record selected transport, per-stream loss, freeze time, client CPU/RAM, API p95 acknowledgement and host CPU/RSS/network over a sustained workload. Build toward a full typical six-hour soak.
- Default receive mode is user-controllable and respects existing multi-publisher permissions. Hidden/closed streams measurably stop receiving where intended.
- Search and media endpoints re-check authorization after role changes; thumbnails and previews remain private and outside public service-worker caches.
- Backups restore to an isolated usable instance, including files/configuration; domestic-only testing checks DNS, web, SFU and local TURN without foreign prerequisites.
- Keep separate current capability statuses: implemented, tested in a stated scenario, untested, or blocked. Retain dated evidence rather than allowing stale matrices to describe the current release.

## Audit evidence files

- [Fresh unit and API results](/D:/Dorham/artifacts/logs/audit-0.4.4-unit.log)
- [Browser defect observations](/D:/Dorham/artifacts/evidence/audit-0.4.4-probes.json)
- [Browser run log](/D:/Dorham/artifacts/logs/audit-0.4.4-browser.log)
- [Browser resource guard](/D:/Dorham/artifacts/evidence/audit-0.4.4-browser-memory.json)
- [Exact fixture cleanup](/D:/Dorham/artifacts/evidence/audit-0.4.4-cleanup.json)
- [Rate-limit reproduction](/D:/Dorham/artifacts/evidence/audit-0.4.4-ratelimit.json)
- [Live operational snapshot](/D:/Dorham/artifacts/evidence/audit-0.4.4-live.json)
- [Public HTTPS and access checks](/D:/Dorham/artifacts/evidence/audit-0.4.4-public.json)
- [Production dependency advisories](/D:/Dorham/artifacts/evidence/audit-0.4.4-dependencies.json)
- [Complete dependency advisories](/D:/Dorham/artifacts/evidence/audit-0.4.4-all-dependencies.json)
- [Raw and offline-compressed bundle sizes](/D:/Dorham/artifacts/evidence/audit-0.4.4-bundle.json)
- [Prior unresolved media capacity measurements](/D:/Dorham/artifacts/evidence/optimization-stress-summary.json)

Reproduction scripts for this audit are under `.tools/audit-0.4.4*`; they are excluded from release source and use isolated fixtures. They contain no production credentials. The normal SSH helper reads its existing private credential store; no credential value is included in the report. No public push, deployment or application behavior change was performed by this audit.
