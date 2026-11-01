# Bundled TTS loading announcements

These two short public phrases were rendered once with the existing Piper 1.8.0 engine and pinned models in `deployment/tts-models.json`. They play locally while the server starts a fresh speech worker; producing the announcement never requires the speech worker itself.

- English: “Text to speech is loading.” — en_US-ljspeech-medium, 1.606 seconds.
- Persian: «سامانهٔ گفتار در حال آماده‌سازی است.» — fa_IR-amir-medium, 2.511 seconds.

Both files are mono 16-bit PCM WAV at 22,050 Hz. `manifest.json` records their text, hashes and sizes. The matching source phrases can be edited and regenerated using `scripts/record-tts-loading.py` in a prepared Piper environment; rebuilding the app only copies and verifies these checked-in recordings. No speech models are bundled with the clients.

Primary model cards: https://huggingface.co/rhasspy/piper-voices/blob/main/fa/fa_IR/amir/medium/MODEL_CARD (Persian dataset CC0) and https://huggingface.co/rhasspy/piper-voices/blob/main/en/en_US/ljspeech/medium/MODEL_CARD (English dataset public domain). Existing copies and Piper's GPL-3.0-or-later engine notice are in `docs/licenses/piper-*`. The spoken text is original app UI copy. No private chat text or human voice recording was used.
