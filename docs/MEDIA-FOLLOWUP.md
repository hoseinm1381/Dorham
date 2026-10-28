# Voice and network follow-up — 28 October 2026

The user reported a real two-person Chrome test: chat worked, one participant used a VPN and the other was in Sweden, but voice and screen sharing failed. A person's voice-channel membership was also invisible until the viewer joined voice. The earlier local decoded-media checks did not establish cross-network media reliability.

## Findings and fixes

- The sidebar used only the viewer's joined `room`; the backend sent room updates only to active voice participants. The fix adds an authorized, minimal `voice:directory` snapshot and bootstrap field. Observers see visible-channel members, mute/deafen state and changes without opening a microphone. Channel overrides and server membership are checked again before each directory delivery. No signaling epochs or credentials are included.
- Membership acknowledgement previously displayed "Voice connected" before a peer connection existed. Mesh status now distinguishes waiting, connecting, connected, timeout and failure. A 25-second unresolved connection provides an actionable media-relay message. Diagnostics include relay availability, ICE errors/state, restart attempts, track readiness and RTP statistics, without TURN secrets.
- The stream viewer now displays connecting/no-video feedback until decoded video arrives. This addresses the unexplained black viewer; it does not itself repair a failed network path.
- No TURN relay is configured on the hosted instance. That is a likely cause of the cross-network failure, especially through a VPN, but a new real cross-network test with diagnostics is required to prove the cause and validate a relay. Do not mark the user's voice/screen problem resolved merely because local synthetic media passes.

## Access without VPN

Current Windows DNS returned `10.10.34.35` for both hosting aliases; HTTPS there was refused. Independent HTTPS DNS returned `51.75.76.215`. A read-only `curl --resolve` test preserving hostname/SNI and normal certificate verification returned **HTTP 200** from `/ready` without the VPN. This confirms the real endpoint was reachable through the current network at test time when DNS was correct; it does not prove every ISP can reach it.

The user authorized Chrome-only Cloudflare Secure DNS, preserving Windows Shecan. Native Chrome automation stopped because it could not confidently determine the active URL. **No DNS settings were changed.** The user was given Chrome Settings → Privacy and security → Security → Use secure DNS → Cloudflare as a manual action. Verify with the user's normal Chrome, VPN off, after it is applied. This change does not configure Android/Electron DNS or repair NAT traversal.

## Validation and remaining gates

`voice-followup-final-verify.log` records lint/typecheck, 14 unit/integration tests and production builds. `voice-followup-final-browser.log` records three real-backend browser scenarios: ordinary chat, decoded audio/video with before-join voice membership and refresh, and deliberately blocked ICE with no decoded media. The failure scenario checks waiting video, timeout feedback, no false successful-call indicator and `relayConfigured: false`. Synthetic sources and blocked-ICE instrumentation are local test fixtures.

Evidence screenshots: `artifacts/evidence/voice-observer-before-join.png` and `blocked-media-diagnostics.png`. Browser memory remained guarded below the 4 GiB user budget; see the latest `browser-memory.json`.

These changes are prepared for the web/backend deployment branch. **Live deployment and live cross-network retest remain outstanding** because browser control was stopped during this turn. Preserve `.env`, `data`, `.cache` and the existing private backup when fast-forwarding the compiled branch, then return startup to `npm start`. Current Windows/APK deliverables predate this UI patch; rebuild them after hosted acceptance.

The user has no existing VPS or TURN service. Cloudflare TURN preparation was authorized. A backend adapter and controlled-response tests are ready, but the signed-in Cloudflare account requires payment details and a usage-billed subscription to activate Realtime. The user explicitly prohibited billing activation, so no subscription, API key or relay was created. See [Cloudflare preparation](CLOUDFLARE-TURN.md). Configure an authorized external relay, validate forced-relay decoded audio/video, then repeat the user's Chrome/VPN/Sweden scenario. Keep TURN outside Botkeep unless the provider explicitly authorizes that workload.

Later, after the user confirmed turning off the VPN, the correct-IP trusted-TLS probe also failed. The earlier successful probe therefore does not establish that Secure DNS alone solves VPN-free access under the new network state. Retest DNS, TLS, fresh login/chat and cross-network media with VPN explicitly off; do not call VPN-free access fixed from a cached PWA shell or the earlier response.

References: [WebRTC TURN guidance](https://webrtc.org/getting-started/turn-server), [Cloudflare TURN FAQ and allowance](https://developers.cloudflare.com/realtime/turn/faq/). Free allowance is not a guarantee against overage charges; do not enable paid billing without separate user authorization.
