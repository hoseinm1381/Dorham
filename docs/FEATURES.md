# Dorham feature management

In **Dorham Monitor → People**, sign in with your Dorham global administrator account and select a user. The right pane shows the account's current rank and individual grants. Choose a Plus, Pro, Ultra, or Max rank and save it, or grant and remove features on their own rows. Open **Expiry and catalog badges** for optional grant expiry and awarded badges. Ban, password, and deletion controls are under **Account actions**.

Open **Server tools** for global switches, 1080p visibility, the asset library, speech providers, and announcements. Assign Community Plus under **Communities**. Overview and SSH settings use a separate connection.

## Initial policy

- 1080p starts hidden and grants are opt-in. The selected and locked modes make the option visible. One HD lease at a time is allowed, at 15 fps. The smaller of the instance capture policy and the configured HD bitrate applies.
- TTS Plus starts disabled. Configure a supported speech API and preview Persian and mixed-language text before applying it.
- Uploads Plus starts disabled. The rolling allowance can increase per account while the shared daily quota, file-size limits and disk reserve still apply.
- Catalog drafts require explicit publishing. Free sound slots are numbered 1 through 8. Publishing a replacement for a populated slot retires the earlier clip. The initial free pack uses slots 1–7. An administrator can publish up to 12 additional free sounds in named bonus packs. Restricted and personal sounds use Soundboard Plus, and personal submissions require administrator approval.

## Catalog files

Use PNG or JPEG images. Emoji may be up to 128 × 128, stickers up to 384 × 384, banners up to 960 × 320 and other images up to 256 × 256. Sounds are mono 16-bit PCM WAV at 8–24 kHz, up to three seconds and 64 KiB. Only published assets are served. Catalog files are stored under the backend data directory in `catalog`. Include that directory with database backups so stable asset IDs continue to resolve.

## Advanced speech configuration

The backend accepts an allowlist through `DORHAM_TTS_PLUS_ENDPOINTS`. Use the service’s protected environment to map exact endpoints to their bearer tokens. Allowlist changes require a backend restart. In Monitor, configure an approved endpoint, model, voice, timeout, per-account quota and overall monthly character quota. Use a visible label that identifies the voice as AI-generated. These settings can be changed or restored without restarting the backend.

- For a WAV-based provider, use its approved HTTPS endpoint. Dorham sends `model`, `voice`, `input`, and `response_format: "wav"`.
- For an OpenAI deployment in a supported region, use `wss://api.openai.com/v1/realtime` with `gpt-realtime-2.1-mini` and a Realtime voice such as `marin`. Dorham requests one audio response per message and assembles one complete WAV. A missing or changed transcript causes standard synthesis to play instead.

Advanced requests use a separate bounded worker and fall back to standard synthesis. In Monitor, **Grant** on an account's TTS Plus row grants access and selects the AI voice together. **Remove** revokes access and returns the account to Standard. **Enable AI voice** completes existing grants that still use Standard.

Monitor's TTS Plus row shows the current UTC month's reserved characters, provider-reported input and output tokens, and estimated USD for supported pricing. The estimate uses the published GPT-Realtime-2.1 Mini rates for each token category. Coverage is shown when provider reports or price estimates are missing. Metering starts at deployment. Earlier character reservations are still available, and admin previews are separate from user totals.

## Resource behavior

The signed-in app fetches feature data on sign-in, reconnect, foregrounding or explicit invalidation. A matching catalog revision skips resending the catalog. Images and sounds use immutable URLs and local HTTP caches. Soundboard playback sends a short voice-room event and fetches a clip only as needed. Speech audio generated from a message uses the existing authenticated short-lived delivery route. Publicly published profile assets and sound effects are reusable files, with Dorham permissions controlling who can select, send or play them.
