# Dorham 1.0.4 Windows and Android release

Rebuilds the current 1.0.4 application for Windows and Android without adding features. The web/server code and data schema are unchanged. Public release links and the small native update notice use the existing downloads manifest.

## Upgrade identity and packages

Windows remains unsigned, as previously selected. App ID com.dorham.chat, product name Dorham and NSIS uninstall GUID 26094eeb-aead-5f8d-b988-ece04b473a4b are unchanged. The actual 1.0.0 to 1.0.4 installer upgrade passes in an isolated directory: one uninstall entry, the same directory/GUID and an exact ASAR match with the packaged build. The personal application's 78 files remain unchanged; backed-up Dorham registry records and shortcuts are restored after the test. The native version/notice/dispatch check passes with an isolated profile.

Android remains com.dorham.chat, now versionName 1.0.4 and versionCode 1000004. The APK signature verifies with the original RSA-3072 signing certificate (SHA-256 2ae98de4ee027368967ec635684a41aab5915c71f4084deda77119138a62383c), matching the signed 1.0.0 release. The signing key and recovery material are excluded from distributables and uploads. Release compilation and vital lint pass. APK ZIP alignment and 64-bit native ELF load alignment pass 16 KiB static checks; these do not certify a physical device.

All 124 current web files match both APK and Windows ASAR, and all six Windows bridge/contract files match source. The existing updater regression checks pass (5 tests). The existing web/backend 171-test and browser/speech verification remain documented in RELEASE-1.0.4.md; they are separate from native device acceptance.

## Publication and device acceptance

The versioned installers are verified before latest.json is promoted. The prior manifest is backed up. Publishing downloads does not restart application, media or proxy services or change their configuration. Previous releases remain available. The public HTTPS manifest, full installer hashes/sizes, HEAD/range downloads, web menu and actual Windows online checker are verified after promotion.

The operator physically tested 1.0.0 to 1.0.4 on a Poco F3 running Android 13: the existing app updated, login was retained, microphone permission was requested/granted, and joining voice, hearing others and speaking all worked. The operator also denied microphone permission and successfully joined as listen-only. Farsi/English TTS playback on the physical phone was not tested; the operator could not test it at this time.

Public downloads: [Windows x64](https://dorhamapp.ir/downloads/1.0.4/Dorham-1.0.4-Windows-x64.exe) and [Android APK](https://dorhamapp.ir/downloads/1.0.4/Dorham-1.0.4-Android.apk). No new feature is included in this native rebuild.
