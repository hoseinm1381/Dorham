# Android 1.1.3 — notification enable correction

Prepared 5 November 2026. This replaces the failed 1.1.2 test candidate. Public release feeds remain 1.1.1; the direct-notification backend is already active and unchanged.

The Poco F3 manual test found that enabling notifications returned a generic error. Read-only server inspection confirmed successful native device registration with a valid session. The failure was in Android setup: Capacitor 8.5.3's `PluginCall.getLong` accepts only a Java `Long`, whereas the JSON bridge decodes a small whole number such as zero as `Integer`. The fallback value then failed the stale-session guard.

The corrected plugin reads the raw numeric value and accepts only exact, finite, nonnegative JavaScript-safe integers. The original comparison against the saved session generation remains in place. Missing values, strings, negative/fractional values, NaN/infinity and unsafe large integers are rejected. A native JVM regression test now covers the actual integer input shape, along with long/double representations and invalid cases. The previous browser mock did not exercise this platform conversion.

Eight native JVM tests pass, including four notification-policy cases and three media-policy cases. Kotlin/Java compilation and both signed release builds pass. Independent checks verify package/version/signing certificate, packaged frontend/native notification code, ZIP 16 KiB and 64-bit ELF alignment. The unchanged backend retains the full Go/Linux, migration/rollback and live private notification/voice/TTS evidence from the [1.1.2 implementation](RELEASE-1.1.2-ANDROID.md).

Package remains `com.dorham.chat`; version code is `1001003`. Install over 1.1.2 or 1.1.1 without uninstalling. Both ARM64 and universal APKs are prepared under `artifacts/android-1.1.3`; final byte counts and hashes are in `apk-verification.json`. The permanent signing certificate is unchanged. Source and APK evidence for the failed 1.1.2 candidate are retained separately.

| Variant | Bytes | SHA-256 |
| --- | ---: | --- |
| ARM64 / Poco F3 | 30,335,486 | `bceaec4ca4a30f459594141e4d075ceb7ef74bc281655f9d3cf16dc3a60e5199` |
| Universal | 70,079,319 | `2d7564d28af129a74a43d450df21463cdd2576d61c7942df5c1fb91c1d82aca5` |

[Corrected Poco F3 test APK](https://dorhamapp.ir/downloads/testing/41d00ca3db7a0f382f88c320e0f04f12/Dorham-1.1.3-Android-arm64.apk). The upload reused identical data from the retained 1.1.2 APK; local and server reconstruction matched the complete newly signed 1.1.3 file byte-for-byte/SHA-256. Public HTTPS bytes and range support were verified. The old test URL was retained unchanged and must not be used for this retest. The live backend and public release feeds were preserved.

The notification system connects directly to the configured Dorham HTTPS server, without Firebase or a companion application. The existing server's subnet is registered as Iranian. The service needs notification permission and background battery allowance for timely screen-off delivery. Its ongoing connection notification is expected; Android Force stop requires reopening Dorham. This correction does not establish physical background/Doze/battery results.

Awaiting Poco F3 / Android 13 retest: enable alerts successfully and confirm the ongoing connection notification, then receive a DM and direct `@username` mention from another account while Dorham's interface is closed and the screen has been locked for five minutes. Tap an alert and confirm its conversation. Extended reboot/network/disable/logout and battery checks remain separate gates.


## Device feedback received

The user confirmed on Poco F3 / Android 13: “it works and sends notification”, with the remaining concern being the permanent connection notice. This establishes user-reported enable and receipt success; it does not individually certify every extended device case above. Android 1.1.4 adds the requested notification controls and supersedes this candidate.
