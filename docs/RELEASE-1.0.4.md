# Dorham 1.0.4 web and server update

Adds all 64 supplied emojis to reaction selection, optional persistent multi-selection and large single-emoji messages. Also adds local Farsi/English text-to-speech for the sender's voice channel. Native binaries remain deferred and the stable native manifest stays 1.0.0.

## Reactions and messages

Add reaction opens the same searchable 64-choice artwork picker. Existing supported Unicode reaction keys remain canonical, preserving historical counts and avoiding duplicate thumbs-up/heart rows. New keys are restricted to the shared catalog; unknown keys and unauthorized reactions are rejected. Selected reactions are highlighted and can be toggled off.

Keep picker open defaults on and remembers the user's preference. Both composer and reaction selection can remain open while choosing several emojis; disabling the switch restores closing after a choice. Exactly one registered emoji or one standard Unicode emoji grapheme is enlarged in the chat. Whitespace is ignored for that decision; text, a second emoji, unknown codes and ordinary digits retain normal sizing. Skin tones, flags and joined family emoji sequences count as one emoji.

## Voice-channel TTS

Use `/tts your message`, or the TTS checkbox beside the composer. Chat text is saved normally with the command removed. When the sender is outside voice, no speech is generated. Otherwise only members of that same voice channel can receive speech, independent of the text conversation they are viewing. Another voice room and mere access to the text chat do not grant speech access.

Speech runs locally using Piper 1.8.0 and pinned Persian amir/English LJSpeech voices. Mixed text switches voices by script. No OS Persian voice or external speech service is required during use. First synthesis may take longer while models load. Speech is limited to 400 characters, one request per sender every four seconds and a four-job queue; ordinary chat delivery is retained on limits/failure. Deafen, server deafen, speak/moderator restrictions, voice epoch changes and sender departure during generation are enforced. Mute TTS is local. Audio is authenticated, private/no-store and expires from a bounded in-memory cache after two minutes. See [TTS operation and licenses](TTS.md).

## Checks and rollout

- Lint, TypeScript, production API/web builds and 171 unit/API tests in 34 files pass. Checks include all 64 reaction values, legacy deduplication, removal, unauthorized/unknown rejection, Unicode single-emoji classification, voice audience/epoch access and sender departure/moderator mute.
- Two-client emoji UI tests pass multi-selection, reaction add/remove, the keep-open switch, 64px single-emoji artwork, normal two-emoji messages, history, Persian mobile layout and offline artwork.
- Three-client TTS browser checks decode and start generated PCM only in the correct voice channel, verify `/tts`, checkbox, normal text outside voice, another room exclusion and deafen. This uses fixture PCM; real Piper synthesis is verified separately for Farsi, English and mixed text. Real sample worker peak RSS was 325652 KiB; this is not a pronunciation or capacity certification.
- A fresh full API/web/config/data online rollback backup was downloaded and independently verified, and restored startup passed before deployment. Web and backend 1.0.4 are live; all 124 public web files match. Both restarts preserve all 35 persistent table digests and stored files (8 at initial rollout, 10 at the final worker patch). The operator explicitly approved the brief API restart even while voice is active. Other media/proxy services and the native manifest are preserved. Public payload, real Node/Piper transport and data-preservation evidence are retained with artifacts/v1.0.4. A cold mixed-language first request passes through the real service-account worker, authenticated API and voice sockets. Worker startup allows 60 seconds and ignores output from expired worker processes.

Refresh the web app after rollout and rejoin voice if the restart disconnected your session. Windows/Android rebuilds remain deferred.
