# Hosted verification — 28 October 2026

Authorized public deployment: https://dorham.bot-keep.xyz/ (client default), https://qrmtdd.bot-keep.xyz/ (permanent address). Source: https://github.com/hoseinm1381/Dorham, branch `main`; compiled runtime branch `codex/botkeep`. No paid service was enabled. The backup operation cleared, and support ticket #65cfa669 is **closed at the user's request**.

Botkeep allocation: Halloween Free, one of three slots used, 1024 MB RAM, 100% CPU and 1024 MB storage assigned. The process binds `0.0.0.0:57267`, using platform `SERVER_PORT`, production HTTPS/cookie/origin configuration in private `.env`, and `DATA_DIR=./data`. No TURN/SFU is running on Botkeep.

| Check | Result and evidence |
| --- | --- |
| Public HTTPS and readiness | Fresh `/ready` returns 200 with SQLite ready through the workstation VPN; web shell and authenticated chat load |
| Web registration/server/channel/avatar/history | Passed; named `Deployment verification` server and `Hosted persistence check — 28 October 2026.` message remain |
| Installed Windows live client | Latest installer passes native registration, actual Socket.IO connection, remote avatar rendering, sandbox/context isolation, no renderer Node integration and protected credentials |
| Explicit WSS and polling | Both passed on the alias, separately recorded in `windows-live-smoke.json` |
| Web/Windows DMs and native restart | Windows sent a message, web received/replied, Windows reopened its isolated profile, rotated its protected refresh credential, read the reply and acknowledged it |
| Repository update and data | Deployment `d53de7f` from source `1912123` is running after a pinned Git fast-forward. Saved web session/server/message/avatar and Windows protected login/DM history survived |
| Linux native dependencies | SQLite, Argon2 registration and Sharp avatar conversion exercised successfully |
| Active chat shutdown | Reproduced an application deadlock before the fix. Moving WebSocket closure to Fastify `preClose` reduced local active-socket shutdown from over 3 seconds to 9 ms. Automated authenticated-socket regression passes |
| Runtime | Actual private receipt confirms Linux **Node 24.22.1**, started `2026-10-28T17:56:19.359Z`, bind `0.0.0.0:57267`, startup RSS 197,652,480 bytes. Provider base Node is 24.21.0; verified bootstrap successfully supplied the patched runtime |
| Infrastructure backup | Completed while stopped, 74.9 MB; downloaded privately and restored only into an isolated local instance. SQLite integrity `ok`, two accounts, saved message and avatar, application readiness and avatar CORS passed |
| Provider resources | After the patched runtime update: approximately 94 MB steady and 178–182 MB during initial warmup; 304.7 MB storage of 1024 MB. Earlier base-runtime samples were 64–98 MB and 180–184 MB. These are light-traffic panel samples, not hosted load measurements |
| Local network | Shecan DNS previously returned a blocked address and HTTPS resets. System VPN restored access; final Windows test uses normal DNS, trusted TLS and no diagnostic resolver override |
| Android | Both APKs rebuilt with the hosted endpoint; debug signature verified. Physical testing awaits the user's phone |
| Hosted load, long idle and real cross-network media | Untested; local control-plane and synthetic decoded-media results are documented separately |

Evidence is under ignored `artifacts/evidence` and `artifacts/logs`: `windows-live-smoke.json`, `windows-live-persistence.json`, `windows-live-dm.png`, `hosted-backup-restore.json`, `shutdown-final-verify.log`, `active-shutdown-before.log` and `active-shutdown-after.log`. The private archive is in `artifacts/backups`; it contains private configuration/data and must never be committed or published. The restoration is not a production rollback test.

The provider's GitHub Sync control intermittently reports busy/unreachable. A reviewed one-time startup command performs `git fetch origin codex/botkeep && git merge --ff-only <pinned-sha> && npm start`, preserving `.env`, `data` and `.cache`. Restore plain `npm start` after update verification. Before deploying the shutdown fix, close app chat sockets so the old version can drain. Console command input goes to application stdin and is not an SSH shell.

`data/runtime-status.json` records the last successful listen timestamp, actual Node version, bind/port, PID and startup RSS. It is operator-only, contains no credentials and is not live-health evidence; use `/ready` for that. The runtime bootstrap uses one process through POSIX `execve`; cached boots do not download Node again.

Instance administration remains unclaimed. Configure a random `BOOTSTRAP_ADMIN_SECRET` privately, claim it from the intended owner's account settings, then remove it. Public registration does not grant administration.

Remaining gates: physical Windows microphone/capture and upgrades; Android installation/permissions/Bluetooth/background capture; configured external TURN/SFU, forced ICE failure and cross-network media; hosted sustained load/long idle; distributed 16-person decoded-media quality. Keep the 4 GiB browser budget and preserve real data and backups. No large browser media run was launched during this VPN verification; browser working-set samples were below the revised budget.
