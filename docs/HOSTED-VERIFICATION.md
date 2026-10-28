# Hosted verification — 28 October 2026

Authorized deployment: https://dorham.bot-keep.xyz/ (alias), https://qrmtdd.bot-keep.xyz/ (permanent address). Repository: https://github.com/hoseinm1381/Dorham, source `main`, compiled production-only branch `codex/botkeep`.

Botkeep account allocation: Halloween Free, one of three slots used, 1024 MB RAM, 100% CPU and 1024 MB storage assigned to Dorham. Node.js 24 profile, startup `npm start`, assigned endpoint `node17.botkeep.cloud:57267`. Environment loads production HTTPS/cookie/origin settings from `.env`. `SERVER_PORT` is supplied by Botkeep. `DATA_DIR=./data` contains SQLite/WAL, avatars and the exclusive instance lock. No TURN or SFU runs on Botkeep.

| Check | Result |
| --- | --- |
| Public web login screen | Passed in user Chrome and Codex browser after production-environment restart |
| Readiness | `GET http://node17.botkeep.cloud:57267/ready` returned 200, SQLite ready; this non-authenticated diagnostic did not transmit credentials |
| Web registration, server/channel, message and avatar | Passed over public HTTPS |
| Native Windows registration and Socket.IO connection | Passed against the permanent HTTPS endpoint; installed app, isolated profile, encrypted credentials, sandbox and background-close behavior verified |
| Explicit WSS upgrade | Alias received Engine.IO opening packet over WSS; permanent endpoint had intermittent connection resets |
| Explicit polling | Alias HTTPS polling opening packet passed |
| Restart and source-update persistence | In progress; do not infer durability from a Running badge |
| Linux native dependencies | SQLite database, Argon2 password registration and Sharp avatar conversion exercised successfully |
| Provider metrics | 64.7–96.4 MB memory at observed idle/light traffic; approximately 180.3 MB storage; these are panel observations, not a hosted load result |
| Console stream | Panel repeatedly reports unavailable/reconnecting; use readiness and `data/runtime-status.json` startup evidence instead |
| Local DNS/network | PC uses Shecan DNS; intermittent connection resets affect some clients. No system DNS, proxy or certificate protection changed |
| Android physical test | Deferred until user connects phone; native endpoint configuration is shared with Windows |
| Hosted load, long idle, cross-network media, backup restore | Untested |

`runtime-status.json` records the last successful listen timestamp, Node version, platform, process ID, bind address/port, database kind and startup RSS. It contains no credentials, is outside served web assets, and is not a live-health signal. Use `/ready` for live readiness.

Deployment update workflow: commit source, run production builds, `npm run deploy:bundle`, `npm run deploy:branch`, then `git push origin codex/botkeep`. In Botkeep's GitHub tab, update the linked branch and restart. The prepared branch has its own Git history and excludes source tools, native packages, development dependencies, local data and secrets. Botkeep's Redeploy control alone does not fetch GitHub changes.

Instance administration has not been claimed by a public registrant. Set a random bootstrap secret in the private Environment panel, claim it in the intended owner's account, then remove it. Keep the secret outside the repository and screenshots.
