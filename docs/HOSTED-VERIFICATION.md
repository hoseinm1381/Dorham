# Hosted verification — 28 October 2026

Authorized deployment: https://dorham.bot-keep.xyz/ (alias), https://qrmtdd.bot-keep.xyz/ (permanent address). Repository: https://github.com/hoseinm1381/Dorham, source `main`, compiled production-only branch `codex/botkeep`.

**Current blocker:** after stopping the app for a consistent infrastructure backup, Botkeep reports the backup Completed (74.9 MB) but keeps its operation pending and disables Start, Restart, Redeploy and GitHub sync. The app's assigned backend port now refuses connections. The PWA login shell can still display from its application cache; that alone does not establish backend availability. Support ticket [#65cfa669](https://botkeep.cloud/app/support/65cfa669-2f67-47b5-8d28-a59c66cfdb18) was submitted with explicit user approval and is awaiting staff. Do not delete or recreate this server.

Botkeep account allocation: Halloween Free, one of three slots used, 1024 MB RAM, 100% CPU and 1024 MB storage assigned to Dorham. Node.js 24 profile, startup `npm start`, assigned endpoint `node17.botkeep.cloud:57267`. Environment loads production HTTPS/cookie/origin settings from `.env`. `SERVER_PORT` is supplied by Botkeep. `DATA_DIR=./data` contains SQLite/WAL, avatars and the exclusive instance lock. No TURN or SFU runs on Botkeep.

| Check | Result |
| --- | --- |
| Public web login screen | Passed in user Chrome and Codex browser after production-environment restart |
| Readiness | `GET http://node17.botkeep.cloud:57267/ready` returned 200, SQLite ready; this non-authenticated diagnostic did not transmit credentials |
| Web registration, server/channel, message and avatar | Passed over public HTTPS |
| Native Windows registration and Socket.IO connection | Passed against the permanent HTTPS endpoint; installed app, isolated profile, encrypted credentials, sandbox and background-close behavior verified |
| Explicit WSS upgrade | Alias received Engine.IO opening packet over WSS; permanent endpoint had intermittent connection resets |
| Explicit polling | Alias HTTPS polling opening packet passed |
| Restart persistence | Account/session, server and avatar survived a completed restart; message history after that restart was not yet independently inspected |
| Source-update persistence | Blocked by the pending provider backup operation. Prepared deployment `6862c5a` from source code `d5aef2d` is pushed but not imported. Existing hosted code is still the first deployment |
| Linux native dependencies | SQLite database, Argon2 password registration and Sharp avatar conversion exercised successfully |
| Provider metrics | 64.7–96.4 MB memory at observed idle/light traffic; approximately 180.3 MB storage; these are panel observations, not a hosted load result |
| Console stream | Panel repeatedly reports unavailable/reconnecting; use readiness and `data/runtime-status.json` startup evidence instead |
| Local DNS/network | PC uses Shecan DNS; intermittent connection resets affect some clients. No system DNS, proxy or certificate protection changed |
| Windows latest installer | Rebuilt with alias prefilled; isolated installation, local registration, sandbox, credential encryption and tray-close test pass. Earlier build passed live native registration against the same backend through its permanent endpoint. Repeated public HTTPS requests had intermittent resets |
| Android physical test | Deferred until user connects phone; both APK variants rebuilt with the shared hosted endpoint, debug V2 signature verified |
| Infrastructure backup | Completed while the app was stopped, 74.9 MB, name `Before hosted client update 2026-10-28`. Local download/restore remains untested |
| Hosted load, long idle, cross-network media, backup restore | Untested |

`runtime-status.json` records the last successful listen timestamp, Node version, platform, process ID, bind address/port, database kind and startup RSS. It contains no credentials, is outside served web assets, and is not a live-health signal. Use `/ready` for live readiness.

Deployment update workflow: commit source, run production builds, `npm run deploy:bundle`, `npm run deploy:branch`, then `git push origin codex/botkeep`. In Botkeep's GitHub tab, update the linked branch and restart. The prepared branch has its own Git history and excludes source tools, native packages, development dependencies, local data and secrets. Botkeep's Redeploy control alone does not fetch GitHub changes.

Recovery continuation:

1. Have Botkeep reconcile the completed backup operation without restoring, deleting or recreating anything. Backup ID: `64ca5915-238d-4148-99a7-e6d98c837141`; server ID: `dcc48719-1c6a-488f-95a0-f242674c020c`.
2. In GitHub, check repository `hoseinm1381/Dorham`, branch `codex/botkeep`. Select **Merge files**, preserving unrelated files including `./data`. Sync the prepared revision and select Start after import.
3. Verify `/ready`, inspect `data/runtime-status.json` for actual Linux Node version and bind port, and confirm the test server, message and avatar remain. The exact hosted Node patch version is still unverified.
4. Run the installed Windows smoke with `DORHAM_SMOKE_SERVER_URL=https://dorham.bot-keep.xyz`; record WSS and polling separately, then test web-to-Windows DMs and a physical voice/capture session.
5. Download the completed private backup to secure local storage and restore its database/avatars into an isolated local instance. Never commit backups or credentials.

During this deployment session, total existing Chrome/Edge working sets briefly measured 4171.2 MiB, including regular user tabs. Closing the agent's active test tab reduced that to 1847.0 MiB. No regular user tabs were closed. The two-page local test suite was not rerun, and the large media test remains disabled.

Instance administration has not been claimed by a public registrant. Set a random bootstrap secret in the private Environment panel, claim it in the intended owner's account, then remove it. Keep the secret outside the repository and screenshots.
