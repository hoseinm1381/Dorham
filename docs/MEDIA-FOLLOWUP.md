# Voice and network follow-up — 28 October 2026

The user reported a real two-person Chrome test: chat worked, one participant used a VPN and the other was in Sweden, but voice and screen sharing failed. A person's voice-channel membership was also invisible until the viewer joined voice. The earlier local decoded-media checks did not establish cross-network media reliability.

The operator subsequently confirmed the follow-up call worked after relay configuration and requested noise/echo cancellation. Built-in processing was already requested on browser and Android capture. The new web/Windows controls expose those defaults and the actual applied microphone settings; saved changes apply after rejoining. See [audio processing](AUDIO-PROCESSING.md). The earlier remote-call acceptance gates below are historical; physical acoustic suppression/echo quality still needs listening tests.

## Findings and fixes

- The sidebar used only the viewer's joined `room`; the backend sent room updates only to active voice participants. The fix adds an authorized, minimal `voice:directory` snapshot and bootstrap field. Observers see visible-channel members, mute/deafen state and changes without opening a microphone. Channel overrides and server membership are checked again before each directory delivery. No signaling epochs or credentials are included.
- Membership acknowledgement previously displayed "Voice connected" before a peer connection existed. Mesh status now distinguishes waiting, connecting, connected, timeout and failure. A 25-second unresolved connection provides an actionable media-relay message. Diagnostics include relay availability, ICE errors/state, restart attempts, track readiness and RTP statistics, without TURN secrets.
- The stream viewer now displays connecting/no-video feedback until decoded video arrives. This addresses the unexplained black viewer; it does not itself repair a failed network path.
- The hosted instance initially had STUN but no TURN. A free external ExpressTURN account is now configured and verified: forced-relay Chrome/Chrome and installed Windows/Chrome clients decoded audio and two non-black screen streams through the real public backend. Repeat the user's physical remote call to confirm that network path and device quality. See [configuration and limits](EXPRESSTURN.md).

## Access without VPN

Current Windows DNS returned `10.10.34.35` for both hosting aliases; HTTPS there was refused. Independent HTTPS DNS returned `51.75.76.215`. A read-only `curl --resolve` test preserving hostname/SNI and normal certificate verification returned **HTTP 200** from `/ready` without the VPN. This confirms the real endpoint was reachable through the current network at test time when DNS was correct; it does not prove every ISP can reach it.

The user authorized Chrome-only Cloudflare Secure DNS, preserving Windows Shecan. Native Chrome automation stopped because it could not confidently determine the active URL. **No DNS settings were changed by the agent.** A later user-performed Secure DNS/VPN-off test still failed. The user explicitly deferred VPN-free access while choosing another provider, so this investigation is no longer active. DNS settings do not configure a media relay.

## Validation and remaining gates

`voice-followup-final-verify.log` records lint/typecheck, 14 unit/integration tests and production builds. `voice-followup-final-browser.log` records three real-backend browser scenarios: ordinary chat, decoded audio/video with before-join voice membership and refresh, and deliberately blocked ICE with no decoded media. The failure scenario checks waiting video, timeout feedback, no false successful-call indicator and `relayConfigured: false`. Synthetic sources and blocked-ICE instrumentation are local test fixtures.

Evidence screenshots: `artifacts/evidence/voice-observer-before-join.png` and `blocked-media-diagnostics.png`. Browser memory remained guarded below the 4 GiB user budget; see the latest `browser-memory.json`.

These changes are **live as compiled deployment `eba59f5` from source `fc950cd`**. A controlled hosted observer saw `Voice observer probe` under Lounge without joining voice or capturing audio; normal leave cleared it. `/ready` returned 200, assets matched `index-BWnMJDl3.js`, and startup is `npm start`. Existing data and the private backup were preserved. The Windows installer has now been rebuilt with this UI and tested against the hosted relay. Android APKs still predate the observer UI patch and need a rebuild/device test before native acceptance. Evidence includes `hosted-voice-observer-live.jpg`, `hosted-relay.json`/`.png` and `windows-hosted-relay.json`/`.png` under `artifacts/evidence`.

Cloudflare preparation produced a tested optional adapter, but activation requires payment details and a usage-billed subscription. No Cloudflare subscription/key was created. The operator instead created a free ExpressTURN account and supplied relay credentials for private Botkeep configuration. Tests force both peers through TURN rather than accepting a direct connection; decoded audio, two simultaneous non-black streams and unsubscribe/resubscribe pass locally, through the public backend, and in the installed sandboxed Windows app. No relay is run on Botkeep. See [free relay setup](EXPRESSTURN.md) and [unused Cloudflare preparation](CLOUDFLARE-TURN.md).

Later, with the VPN explicitly off, the correct-IP trusted-TLS probe also failed. The earlier successful probe therefore does not establish that Secure DNS alone solves access. VPN-free access remains unresolved and deferred at the user's request. Current relay tests ran with the VPN connected; they make no VPN-free claim.

References: [WebRTC TURN guidance](https://webrtc.org/getting-started/turn-server), [Cloudflare TURN FAQ and allowance](https://developers.cloudflare.com/realtime/turn/faq/). Free allowance is not a guarantee against overage charges; do not enable paid billing without separate user authorization.
