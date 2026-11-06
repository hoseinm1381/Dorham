# Android 1.1.2 — superseded test candidate

**Physical test failed at notification enable. Do not promote this APK.** Server registration succeeded, but Capacitor's `PluginCall.getLong` rejected the small integer sent through the Android JSON bridge, causing the stale-session guard to reject setup. The 1.1.3 correction accepts exact safe numeric values without removing that guard and adds a regression test. The source files before the fix and the original signed APKs are retained. The successful mocked-bridge UI checks below did not exercise this native argument conversion.

Prepared 5 November 2026. The notification backend is active on the existing Dorham VPS. Android 1.1.2 is a signed device-test candidate; public Android and Windows update feeds remain 1.1.1. No Firebase project, companion application or separate notification server process is required.

## Behavior

Enable **Account settings → Notifications → Notify me about direct messages and mentions**. Allow Android's notification permission and use **Allow background notifications** for timely screen-off delivery. The native service receives generic private alerts directly over HTTPS from the configured Dorham server, including while its interface/WebView is closed. Tapping an alert opens its conversation. A low-importance ongoing notification shows connection state and offers **Stop alerts**.

Android Force stop prevents delivery until Dorham is reopened. Boot/package-update restart, OEM auto-start restrictions, extended Doze, network handover and real battery cost still need physical validation. The service holds no permanent idle wake lock; delivery work alone has a ten-second bounded wake lock. Reconnects use backoff and a network-change callback. No battery-saving percentage is claimed.

The server queues up to 64 alerts per registered device, with seven-day expiry. Only DMs and direct username mentions qualify. Notification credentials are hashed on the server, bound to a native login session and restricted to delivery/acknowledgement. They cannot read messages or use the full API. Android encrypts its credential with Android Keystore; the service does not need the login/refresh token. Permissions, blocks, read status, deleted/edited mentions and do-not-disturb status are checked before delivery. Acknowledging an alert does not mark its chat read. Logout/server changes clear local credentials; server session revocation disables delivery. Only intended recipients' waiting connections are signaled.

Delivery uses `dorhamapp.ir` on the existing VPS, which resolves to `45.135.242.146`. RIPE NCC RDAP records subnet `45.135.242.0–45.135.242.255` with country `IR`; this is network-registration evidence, rather than independent physical datacenter attestation. No FCM or foreign push relay is used by this notification path. Evidence: `artifacts/android-1.1.2/hosting-location.json`.

## Packages

| Variant | Bytes | SHA-256 |
| --- | ---: | --- |
| ARM64 / Poco F3 | 30,335,486 | `7f0edc55e04e1e4c9c68b19f8287bd255ee21282ac8c4d109815a49dca61fd50` |
| Universal | 70,079,319 | `38082a1fa379cf7789669cfbab8af696c527c91831b7c1b1a9fb0898e2ae1d6d` |

Files are under `artifacts/android-1.1.2/arm64` and `universal`. Package `com.dorham.chat`, version code `1001002`, minimum Android 10/API29, target API36. Both retain certificate SHA-256 `2ae98de4ee027368967ec635684a41aab5915c71f4084deda77119138a62383c`. Install over 1.1.1; do not uninstall. Android now has its own package version; shared web/Windows remain 1.1.1. The UI uses the native version when available. Superseded initial candidates are preserved separately and should not be installed.

[Unlisted Poco F3 test APK](https://dorhamapp.ir/downloads/testing/43a4a72187b319c39ffe265bdd7c70b9/Dorham-1.1.2-Android-arm64.apk). Its complete public bytes and range support were independently verified from the laptop. Original account/message identifiers, database integrity, service processes and protected files were checked after staging this download. `phone-test-publication.json` and `public-test-verification.json` record the result. The public release feeds were not promoted.

## Verification

- Full shared unit/API suite: **237 tests in 48 files pass**. Final migration tests, typecheck and scoped lint pass.
- Full Go suite passes. Notification tests cover private DM/mention delivery, device-specific acknowledgement, replay/credential rotation, no full-API privilege, recipient-only wakeup, blocks, removed membership, deleted messages/removed mentions, already-read messages, queue cap/expiry, session expiry/revocation and long-poll wakeup.
- Final Linux security tests and production binary boot pass. An isolated populated schema-12 database also boots with the preserved previous backend, with integrity and existing account data retained.
- Seven Android JVM tests pass, including three notification-policy tests and three existing media-policy tests. Kotlin/Java compilation and release vital lint pass. These do not prove physical background-service behavior.
- Headless touch Chrome at 390×844 passes settings enable/disable, real Go registration and private DM delivery/ack/revoke, version display, Persian layout, and prior channel/member/call/native-renderer requests. The native bridge and renderer events are simulated. No physical Android delivery or decoded-media result is inferred from these tests. Screenshots were visually inspected.
- Both final APKs pass independent signature, version, packaged frontend/DEX checks, ZIP 16 KiB alignment and 64-bit ELF load alignment.
- Live private production checks pass direct mention delivery, a held HTTPS poll receiving a DM, scoped credentials, acknowledgements and registration revocation. Voice/screen-audio grants, Persian/English/mixed complete speech, progress, cache reuse and old-membership/outsider denial pass. Forty-six heartbeat samples had no errors, with a maximum of 319 ms in this bounded probe. Existing CPU isolation and one persistent speech worker were retained.

Evidence is under `artifacts/android-1.1.2`, including `backend-deployment.json`, `production-probe.json`, `apk-verification.json`, build/test logs and `ui/`. Device acceptance is pending; Android updater installation and sustained battery/thermal behavior are separate gates.

## Backend rollout

Active binary SHA-256: `4365948e8c0370b58a5cb7656d1def759f35c73eefd99bff7037ff95f5f05df0`. Additive migration 12 creates notification devices, queue and indexes without rewriting existing tables. Matching DDL is included for the legacy TypeScript backend. The preserved previous Go binary ignores the additional tables on rollback, as verified in isolation.

Consistent pre-activation database and previous binary are retained under `/var/lib/dorham-ops/backups/notifications-before-ca9e5d9b8c62`. Only Dorham restarted. Config, speech worker/models, service limits, web shell, existing Windows/Android APKs and their feeds were preserved. Private probe fixtures, including its exact DM, were cleaned and database integrity checked. No rollback timer remains pending.

An early final-stage test stalled in Linux temporary-directory creation before application code ran. Concurrent I/O pressure and a readiness timeout were observed; no heavy writer or kernel storage error was identified. After readiness recovered, the exact final tests and migration/rollback boot passed on the normal filesystem. This was not labeled a notification-code failure or a proven hosting-provider fault.

## Poco F3 acceptance

The user agreed to test now; reported outcomes are pending. Check installation over 1.1.1, enable alerts/battery permission, receive a DM and `@username` mention from another account after closing/swiping away the interface and locking for five minutes, then tap an alert into its correct conversation. Follow with reboot, Wi-Fi/mobile reconnection, notification disable/logout and extended idle/battery checks. Do not promote the public APK feed from browser/JVM results alone.
