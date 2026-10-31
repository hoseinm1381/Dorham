# Dorham 1.0.0 desktop and Android release

Built and verified locally. **Server upload/deployment is deferred at the operator's request while using a VPN.** The public site remains on 0.7.7. This release adds the small **Get apps** control on the sign-in screen and main toolbar; its menu links to the Windows installer and Android APK. A small **Update** button appears in native apps when a newer release is available. Checks run at startup, hourly and after returning online/to the app, with a five-minute foreground throttle. A failed check does not interrupt sign-in or calls. Equal or older Windows versions do not prompt a downgrade.

## Real updates

Windows keeps `com.dorham.chat`, product name Dorham and the existing NSIS uninstall GUID `26094eeb-aead-5f8d-b988-ece04b473a4b`. The installer reuses the installed location, offers no new directory selection, and retains application data. The app allows one running instance per profile. Update downloads use the official HTTPS release origin, an exact validated filename, declared size and SHA-256. The installer opens after verification; the app then exits. An active voice call blocks installation, including a call that starts while downloading. Its single cached installer is replaced on the next update. Windows is **unsigned**, as selected by the operator. It has no trusted publisher signature.

Android keeps application ID `com.dorham.chat`, version name `1.0.0` and version code **1000000**. Build numbers derive from major * 1000000 + minor * 1000 + patch. This is the first release signing key; future releases MUST reuse it. The native updater checks the official manifest, SHA-256/size, package ID, increasing build number and the installed signing certificate before opening Android's normal update confirmation. Android may first ask the user to allow Dorham to install updates. It replaces the same package and retains its data. The signing password has a Windows-encrypted working copy and an explicitly requested private plaintext recovery file; neither belongs in Git, distributables or server uploads. The key and recovery materials have a second verified private copy.

The old 0.3.0 debug APK used a different debug signing key. It is not an in-place upgrade target for this first release key. All future signed releases can use the new permanent identity. No Android device was connected for a physical install/update test.

## Verification

- Lint, TypeScript, production API/web/desktop builds and all **156 unit/API tests in 30 files** pass. New checks cover numeric version ordering, trusted release addresses, tampered downloads and voice-call protection.
- Three guarded Chrome scenarios verify download menus before/after sign-in, mobile layout, update dispatch and unavailable-metadata behavior. Screenshots were inspected.
- The actual Windows package reports native version 1.0.0. Its native bridge checks a simulated future manifest and shows the small notice, hides it at an equal version, and dispatches the install action. This isolated test does not execute an installer.
- A separate real NSIS upgrade **0.7.6 -> 1.0.0** passes in the dedicated test installation: same directory, same GUID and exactly **one uninstall entry**. The original registry pointed to a missing program folder, so the preserved 0.7.6 installer recreated the baseline first. All 78 baseline application files and the original registry/profile state are backed up privately. The upgraded installed payload matches the final package; its native check also passes.
- All **59 web files and six Windows shell/contract files** match the ASAR. The signed APK contains the same 59 web files. Android Gradle release compilation and vital lint pass; APK Signature Scheme v2 verifies with one RSA-3072 signer. Certificate SHA-256: `2ae98de4ee027368967ec635684a41aab5915c71f4084deda77119138a62383c`.
- Android APK ZIP alignment and all six arm64/x86_64 native-library ELF load alignments pass 16 KiB static checks. Minimum SDK 29, target SDK 36. These checks do not certify a physical device or a 16 KiB runtime.

## Packages and later upload

`artifacts/v1.0.0/windows/Dorham-1.0.0-Windows-x64.exe` and `artifacts/v1.0.0/android/Dorham-1.0.0-Android.apk` are the installers. `downloads/` contains only public installers, versioned checksums and `latest.json`. The source, compiled server, verification archive and final checksums are separate deliverables. Signing materials stay under private `.tools` folders, excluded from all archives.

Run `npm run release:downloads` after building both installers. For the later authorized deployment, take a fresh independently verified data/configuration backup, upload the immutable version directory to `/var/lib/dorham-downloads/1.0.0/`, validate hashes, then publish `latest.json` last. The Caddy snippet is [downloads.Caddyfile](../deployment/downloads.Caddyfile): import it in the existing site block before the application handler, validate Caddy and reload. Test public GET/HEAD/range downloads and manifest CORS from native/web clients before deploying the matching web bundle. Never upload the signing folders or private recovery files.

Future releases must increase the version and Android build number, reuse both app IDs and the Android signing key, rebuild both packages, and publish a matching verified manifest. Direct APK signing and package updates follow [Android app signing](https://developer.android.com/studio/publish/app-signing); stable Windows upgrade identity follows [electron-builder NSIS](https://www.electron.build/docs/nsis/).

Android physical installation/update, device media/background permissions, physical microphone quality, weak-device CPU and new media capacity acceptance remain open. No database migration or server runtime dependency change is included.
