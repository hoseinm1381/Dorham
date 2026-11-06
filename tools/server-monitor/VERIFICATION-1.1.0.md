# Dorham Monitor 1.1.0 verification — 5 November 2026

The integrated build includes Monitor 1.1.0, the Go account administration API and the web changes for retained chat history. Go schema 13 follows the Android notification migration. The backend and web client went live on 5 November 2026 at 15:10 Tehran time.

- The Go suite passed against SQLite. The account lifecycle test covered authorization, chosen temporary passwords, recovery invalidation, bans, socket and notification revocation, deletion confirmation and replay, server ownership, historical authors and pagination.
- The production-mode compatibility run passed 46 checks using loopback SQLite and the PostgreSQL WASM engine through the real pgx TCP adapter. PostgreSQL checks covered schema 13, deletion rollback on audit failure, ownership transfer and preserved event sequences. The Node → Go → Node check passed and verified that deleted accounts remain retired through rollback.
- The web production build and TypeScript checks passed. A guarded Chrome test verified that a direct chat already open during deletion keeps its messages, updates the author and becomes read-only.
- Vitest passed 240 of 241 tests inside the sandbox. The backup/restore test passed when rerun with access to the Windows user profile required by tsx.
- The packaged Windows executable passed 43 offline checks and the WPF interaction checks with synthetic data. The ZIP contains the same executable bytes. The admin UI checks exercised the monitor with a fake HTTP transport. The Go API and browser checks used disposable local accounts.

NuGet restored pinned packages from the local cache. Its online vulnerability index was unavailable during this build.

## Live verification

- The isolated rehearsal migrated a consistent copy of the production SQLite database from 12 to 13 and preserved its account count. Activation restarted Dorham and verified the public readiness, LiveKit configuration and Android notification endpoints. All 137 public web files matched the staged build. The Windows 1.1.2 and Android 1.1.6 feeds were preserved.
- The built Monitor 1.1.0 WPF Users panel ran in a test host against the live HTTPS API. Administrator sign-in, protection of the operator account, ban, unban, device revocation, generated and chosen temporary passwords, forced password replacement, deletion confirmation and sign-out all passed. The remaining DM participant could read the preserved message under **Deleted account**, and new writes to the chat were rejected.
- The runner used two disposable accounts, including a temporary global administrator, and one private test chat. It removed both accounts, their sessions and their test chat. The test audit entries were retained. Postflight checked the running executable hash, schema 13, database integrity, and the original count of one global administrator.

Live receipts are in `artifacts/server-monitor/evidence/live-1.1.0` as `activation.log`, `public-verification.json`, `monitor-live-proof.json`, and `postflight.json`. The rollback snapshot and previous files are retained on the server at `/var/lib/dorham-ops/backups/monitor-admin-before-4880dd2c95a5`.

Evidence is in `artifacts/server-monitor/evidence/integrated-1.1.0`. The packaged Windows executable is in `artifacts/server-monitor/windows-x64-1.1.0`. The Linux x64 backend is in `artifacts/server-monitor/backend-1.1.0` and the web build is in `apps/web/dist`.

| Artifact | SHA-256 |
| --- | --- |
| Dorham Monitor.exe | `59893E3F1FFB29F1EE129866404CF8F3DD60A4BB20C05A616CA0323C8ED4C83D` |
| Dorham-Monitor-1.1.0-Windows-x64.zip | `F8053E3651EBFEAC99EAEC896A0378551C329D27CB61DBC1D5318BF71203554D` |
| Linux x64 dorham | `D61889DE968E2A5A51E6331DCF7442FF1B945D01BF6134160DD05C68A493A27B` |
