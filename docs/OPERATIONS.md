# Operations and recovery

## Storage and retention

Default limits: 100 users, 20 online users and 16 voice members per channel. Fixed room/global publisher caps default to zero (disabled), retaining one publication per account and expiring leases. Existing installations must update old environment values to remove their caps. Retention defaults to 90 days and 50,000 stored messages; reaching the message ceiling prunes a bounded batch of the oldest messages. Replay events retain seven days with a global 50,000-event ceiling; mutation receipts retain one day. Pruning runs in bounded maintenance transactions. Deletion leaves replayable tombstones until normal retention removes them. The [Iranian pilot](NINECRAFT.md) also has incoming-traffic monitoring and reduced publishing settings.

SQLite uses a 256 MiB page ceiling and a bounded WAL journal policy; avatars have a separate 16 MiB quota. Uploads are decoded with pixel limits and re-encoded to 128px WebP, at most 96 KiB each. General attachments use a separate 2 GiB budget and 2 GiB free-space reserve; see [attachment limits and expiry](ATTACHMENTS.md). Logs go to stdout/stderr; configure provider log rotation/retention. Keep the production deployment plus data below 80% of the actual disk allocation and include temporary backup space in that calculation. SQLite disk-full errors return a storage-specific 507 response.

`GET /api/v1/admin/metrics` requires instance administration and reports process RSS, CPU time, uptime, connected users, messages, share leases, database-file bytes, and storage warnings. Maintenance checks SQLite and avatar budgets every minute and logs a warning when either crosses 80%. CPU is cumulative; compare two samples over an interval. These are application budgets, not a provider resource meter; monitor actual disk allocation and backup space separately. PostgreSQL storage remains an operator-managed external budget.

## Backups

From the source repository, with `.env` pointing at the intended data directory:

```powershell
npm run db:backup -- D:\Backups\dorham-2026-10-28.sqlite
```

The SQLite online backup API creates a consistent committed database snapshot while the application is running. It does **not** copy avatars or attachments. Stop the application for a coordinated snapshot and copy `avatars`, `attachments`, and private configuration with the database. Keep independent backups outside the hosting account and outside the public web directory. Treat backups as private user data. The deployment bundle exposes the same backup command through the compiled database CLI.

For provider-level backups, follow Botkeep's documented requirement to stop databases before backing them up and stop workloads before restore. A panel operation is not a recovery point until it reports completed success. Do not keep enough local copies to exhaust the 1 GiB account pool.

For PostgreSQL use `pg_dump` with connection credentials supplied securely through the environment or a password file. The built-in SQLite backup command refuses PostgreSQL rather than emitting a misleading backup. Exercise `pg_restore`/`psql` recovery against an isolated database.

## SQLite restore

1. Stop the server and confirm it is offline. Keep an independent copy of its current data first.
2. Run `npm run db:restore -- <verified-backup.sqlite>`.
3. The restore command checks database integrity and schema identity. It refuses a live instance lock, creates a new database from the backup, and preserves existing database/WAL/SHM files with timestamped names.
4. Restore the corresponding avatar and attachment directories, retaining the prior avatar copy separately.
5. Start the application and verify credentials, server/channel membership, message history, and images. Voice rooms begin empty after a restart.

Restore supports SQLite snapshots created by this application. It does not import arbitrary SQL, raw files copied while WAL writes were active, or an unrelated schema. Restored databases include session records; rotate/revoke sessions before reopening a restored instance if the backup may have been exposed.

## Migrations

The versioned, idempotent schema is initialized through Drizzle at startup. `npm run db:migrate` performs the same initialization without opening an HTTP listener. For upgrades, stop the application, export a verified backup, apply the new version, and validate. Version 0.1.0 defines schema version 1; future structural changes must add explicit migration versions and upgrade tests, rather than silently changing old DDL.

## Native builds and signing

Windows: `npm run package:windows` produces a per-user x64 NSIS installer. No code-signing certificate is supplied; the installer is unsigned and Windows may show its normal publisher/SmartScreen prompts. No installer is silently run on the user's normal installation during packaging.

Android: install JDK 21, Android SDK 36, and compatible build tools, set `JAVA_HOME` and `ANDROID_HOME`, then run `npm run android:build`. The script also recognizes the local `.tools` runtimes downloaded during development. Gradle's wrapper pins its distribution and checksum. The application minimum is Android 10/API 29. Debug APKs use the Android debug signing identity and are for local testing.

Release signing reads `DORHAM_KEYSTORE`, `DORHAM_STORE_PASSWORD`, and `DORHAM_KEY_PASSWORD` from the environment, using alias `dorham`. Keep the keystore outside the repository; preserve it and its recovery credentials independently if distributing updates. Never publish a debug-signed build as a production release. The application does not enable billing, purchase signing certificates, publish store listings, or upload binaries automatically.

## Production review

- Set HTTPS/WSS, exact allowed origins, secure cookies, public URL, and a verified persistent directory.
- Claim instance administration using a random single-use secret; remove the secret afterward.
- Keep API, TURN, SFU, and signing credentials outside source and artifacts.
- Run one backend process; verify capacity and reconnect behavior with representative clients.
- Test backups and monitor the actual shared hosting budget.
- Verify cross-network TURN/SFU behavior and physical native audio/capture before promising it to users.
- Publish the instance's privacy/retention information before admitting public registrations.
