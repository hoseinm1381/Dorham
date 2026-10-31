# Dorham 0.7.7 - simpler audio and profile pictures

Deployed at **https://dorhamapp.ir/** after isolated SFU checks and independent rollback-backup verification. GitHub source and compiled-runtime publication accompany this release. The previous deployed release is documented separately in [0.7.6](RELEASE-0.7.6.md).

The main Audio view contains microphone volume, **Off / Standard / Strong** noise removal, and a private voice test. Device selection, high boost, talk keys, echo cancellation, automatic level and voice clarity are grouped under **Advanced audio**. High boost remains opt-in and existing saved volume settings are preserved. The removed manual noise threshold uses the quiet-microphone-friendly default, so an old aggressive threshold cannot silently cut off quiet words. Switching processing controls cannot overlap and overwrite another setting. Closing the private test also releases its call isolation.

**Standard** retains browser noise suppression and the existing optional high-gain pause filter. **Strong** adds a bundled RNNoise neural denoiser on the user's device. It normalizes very quiet input for the model, compensates that level, and then applies the selected outgoing volume. The browser's echo protection is retained. Assets come from this application; recordings are not sent to a denoising service. Standard remains the default for low processing use. Model/worklet loading errors or unsupported sample rates fall back visibly to Standard. The outgoing mute gate remains after processing.

The RNNoise worklet runs at 48 kHz and loads lazily when Strong is used. Mesh and private playback use 48 kHz contexts; LiveKit receives an explicitly owned 48 kHz playback/processor context. The pinned `@sapphi-red/web-noise-suppressor` 0.4.1 build adds a startup/error handshake and starts the worklet's destroy-message port. Its DSP and frame buffering are unchanged. CSP permits WebAssembly compilation without enabling JavaScript `unsafe-eval`. Third-party licenses are included in the application and [source notices](licenses/web-noise-suppressor-MIT.txt).

Profiles offer **16 original pictures**: eight animals, four robots and four space illustrations. Custom PNG/JPG/WebP uploads remain available. Both choices use the existing validated avatar API and storage policy; there is no schema migration. Editable SVG sources and their generator are retained. Both DM lists use the same avatar renderer and colour calculation, including people who have not uploaded a picture. Public default pictures and denoiser assets are cached with the PWA shell; private API and uploaded-avatar responses remain excluded.

## Verification

- Lint, TypeScript and production API/web/desktop builds pass. All **151 unit/API tests in 28 files** pass.
- Chrome verifies simple defaults, opt-in boost, saved noise modes, English/Persian mobile layout, all 16 thumbnails, preset/custom persistence, live avatar refresh and matching DM fallback colours.
- Actual bundled RNNoise processing at **+30 dB**, with deterministic noise and locally synthesized speech, reduces the post-warm-up noise amplitude to about **1.8%** of bypass (about **35 dB** lower). The measured speech-window amplitude is about **92%** of bypass. This is a synthetic signal measurement, not an intelligibility or physical-microphone certification. Initial model adaptation is not included in the post-warm-up figure.
- A missing-model test verifies audible fallback, mute silence during processing/gain changes, and recovery. Graph destruction and capture restart regressions pass.
- Existing browser call checks verify processing changes, persistence, mute preservation and talk-key behaviour. The private-test call regression separately verifies mute/deafen isolation and restoration. The public preset/model cache also passes offline checks without caching private API responses.
- Isolated real LiveKit/SFU checks verify Strong startup, decoded synthetic speech at +30 dB, mute silence, muted microphone replacement and rejoin. A separate two-client private-test check verifies call isolation and restoration. Only temporary fixture rooms and accounts were used and removed.
- The packaged **unpacked Windows build**, using its own temporary profile and local backend, verifies registration, preset upload/decoding, simple audio, RNNoise startup through `dorham://app`, private playback panel closure, sandboxing and context isolation. The installer is built; a new installation/upgrade is not certified by this check.

Deployment preserves all **35 persistent table digests**, **four avatar/attachment files** and the exact runtime configuration. Schema remains 9. The independently downloaded backup verifies **38 tables and five files**, SQLite integrity and foreign keys. The prior application is retained at `/opt/dorham-before-0.7.7`. All four services remain active.

Evidence is under `artifacts/evidence/v077-*`; the Windows installer and release packages are under `artifacts/v0.7.7`.

Physical microphones, subjective clarity, CPU performance on weak devices, Android packaging/device behaviour and a new capacity certification remain open. A stronger filter cannot restore clipped input or guarantee clear speech at extreme gain. No server runtime dependency or database schema change is required for this update.
