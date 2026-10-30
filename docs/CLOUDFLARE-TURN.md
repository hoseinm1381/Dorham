# Cloudflare TURN preparation

The backend integration is implemented and tested against controlled API responses. **Cloudflare TURN is not activated or live-tested.** On 28 October 2026 the signed-in account's Realtime enrollment page required card details, a billing address and **Save payment details & activate Realtime**. It showed 1,000 GB/month included, then $0.05/GB, and automatic subscription renewal. The user authorized preparation only, with no billing/paid activation. No payment details were entered, no subscription was activated and no TURN key was created.

The free allowance is not a zero-billing account or a hard spending cap. Do not activate that subscription under the current authorization. An operator-controlled external coturn host using the existing `TURN_SECRET` mechanism is the other supported route; no host is currently available. Do not install a relay on Botkeep without explicit provider permission.

## Integration ready for an authorized account

If billing eligibility is resolved separately, the operator creates a dedicated TURN key in Cloudflare Realtime and puts these values in the backend's private Environment configuration:

```dotenv
# Leave TURN_URLS and other TURN provider credentials empty.
CLOUDFLARE_TURN_KEY_ID=<TURN-key-ID>
CLOUDFLARE_TURN_API_TOKEN=<TURN-key-specific-API-token>
```

Keep both values outside Git, frontend builds, ZIPs, screenshots and support logs. Do not use a global Cloudflare API key. Configuring only one value or combining this provider with `TURN_URLS` prevents startup with a clear configuration error.

Before granting voice membership, the backend authorizes the user/channel, then calls the fixed official credential-generation endpoint outside the write transaction. Membership and capacity are checked again inside the transaction. The request sends only the TURN-key authorization and credential lifetime; it does not send usernames, chat or profiles to Cloudflare. The browser/native application receives only temporary ICE credentials.

Credentials have a 24-hour lifetime. A per-user 60-second cache coalesces retries, with a bounded 100-user cache and a five-second provider timeout. Failed issuance is cached briefly too, and returns safe `TURN_UNAVAILABLE` text without provider response bodies or tokens. No voice membership is left behind on issuance failure. UDP/TCP/TLS URLs from Cloudflare are validated; browser-blocked port 53 is excluded. Existing static/shared-secret TURN remains available as a separate configuration.

Continuous calls beyond credential expiry currently require leaving/rejoining voice; automatic in-call credential renewal is not implemented. This limit also applies to current native clients. Do not certify a 24-hour call from unit tests or short browser runs.

## Verification after activation

1. Confirm the key remains server-only and unauthorized users cannot generate credentials. Test safe behavior during provider outage without creating ghost participants.
2. In an isolated test client, force `iceTransportPolicy: relay`; assert a selected relay candidate pair **and decoded audio samples/video frames**, then test mute/deafen, two screen publishers, unsubscribe and moderation. Record traffic and quota use.
3. Repeat the actual user's Chrome/VPN/Sweden scenario, then test both clients without VPN, checking DNS/TLS separately from media connectivity.
4. Monitor provider quota/billing. Client or backend RTP estimates do not enforce Cloudflare's billable usage or prevent modified clients from using issued credentials until expiry. A financial spending cap cannot be claimed from this application.

References: [official credential API](https://developers.cloudflare.com/realtime/turn/generate-credentials/), [TURN service and ports](https://developers.cloudflare.com/realtime/turn/), [pricing FAQ](https://developers.cloudflare.com/realtime/turn/faq/).
