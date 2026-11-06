# Android 1.1.4 — notification controls

Published 5 November 2026. The user authorized publication after building and explicitly waived further phone testing. Package remains `com.dorham.chat`; version code is `1001004`, with the permanent release certificate. Install over the existing app to retain login/settings.

- Each chat can produce an Android message alert once per 15 seconds. Chat B can still alert immediately after chat A. Messages suppressed during the gap remain in chat and are acknowledged without a delayed alert burst.
- The bell button in each chat mutes that chat until explicitly unmuted. A message notification also offers **Mute this chat**. Preferences persist locally across app restarts and disable/enable or sign-out, scoped to server/account. This does not mute other chats or synchronize a preference to other devices.
- Foreground Android message cues/toasts also respect chat mute and a per-chat gap. Foreground and native-background cooldown timers are independent.
- The ongoing service notice now uses the simple Dorham title and offers **Hide connection notice**, also available in Account settings → Notifications. Android requires a foreground-service notice: users can hide only **Notification connection** in Android's category settings while leaving **Messages and mentions** enabled. The app does not silently disable that category. Android's active-app indicator can remain. Force stop still requires reopening the app.

The existing Iran-hosted direct-notification backend remains active and unchanged, without Firebase or a companion app. Delivery still depends on notification permission and Android background/battery allowance. The [1.1.3 enable correction](RELEASE-1.1.3-ANDROID.md), durable queued delivery, credential/session guard and native media improvements are retained.

## Build evidence

Before the final signed build: TypeScript and scoped ESLint passed; all 237 tests in 48 files and 10 Android JVM tests passed, including separate-chat cooldown, the exact 15-second boundary, persistent mute policy and numeric session conversion. Kotlin/Java compilation and both signed release builds succeeded. Final APK signature/certificate, package/version, bundled frontend files/native classes, ZIP 16 KiB and 64-bit ELF alignment were independently verified. No additional phone test was requested or performed for 1.1.4. The user previously confirmed 1.1.3 notification enable and receipt on Poco F3 / Android 13.

| Variant | Bytes | SHA-256 |
| --- | ---: | --- |
| Universal | 70,096,671 | `b860d8a7da219a684f34c484394be498f140b083e9d40497d2653a70cfe629d3` |
| ARM64 / Poco F3 | 30,352,838 | `bc04f823112f3bee7b2e51a99ddba84fb861beaac888b2e38ace64d6c5ddc29a` |

[Universal APK](https://dorhamapp.ir/downloads/1.1.4/Dorham-1.1.4-Android.apk) · [ARM64 / Poco F3 APK](https://dorhamapp.ir/downloads/1.1.4/Dorham-1.1.4-Android-arm64.apk). Signing certificate SHA-256: `2ae98de4ee027368967ec635684a41aab5915c71f4084deda77119138a62383c`.

## Publication and rollback

The exact signed bytes were reconstructed from retained installers using verified compressed ZIP-entry spans plus literal bytes. Local and server full-file SHA-256 matched. Server and independent laptop HTTPS downloads verified both APKs and byte ranges. Android's platform feed now advertises 1.1.4, and the schema-2 download catalog combines Android 1.1.4 with Windows 1.1.1. The Windows feed and legacy latest manifest retain their exact bytes for compatibility. Current Android clients use android.json; older clients using the legacy feed can update to 1.1.1 first. Website shell, backend binary, TTS worker/models/config, Windows installer and service identities/limits were preserved; no service restart was needed.

Release-catalog and metadata backup: `/var/lib/dorham-ops/backups/android114-catalog-before-423d2dc8ebaa`. Restore only those saved catalogs/metadata for release rollback; do not restore the live database. Previous immutable installers and test candidates are retained. Detailed source hashes, build logs, APK reports and publication evidence are under `artifacts/android-1.1.4`.
