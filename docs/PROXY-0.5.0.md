# Trusted client addresses for the Iranian pilot

The application must not trust arbitrary forwarded headers. `TRUSTED_PROXIES` defaults empty. The current backend listens on loopback. A release must preserve that restriction and configure only its actual proxy source, for example `TRUSTED_PROXIES=127.0.0.1/32` when Caddy connects over IPv4 loopback.

The pilot terminates TLS in HAProxy and forwards HTTP to loopback Caddy. Forward the real socket address with PROXY v2 on both Caddy-bound HAProxy backend `server` lines (`send-proxy-v2`). Require PROXY headers from loopback at that Caddy listener. This is a candidate rollout instruction; it has not been applied to the live 0.4.4 installation.

For this HTTP-only, loopback Caddy listener, merge the following into its global options:

```caddyfile
servers {
    listener_wrappers {
        proxy_protocol {
            timeout 2s
            allow 127.0.0.1/32
            fallback_policy reject
        }
    }
}
```

In the application reverse proxy, overwrite client forwarding headers:

```caddyfile
reverse_proxy 127.0.0.1:3001 {
    header_up X-Forwarded-For {remote_host}
    header_up X-Real-IP {remote_host}
}
```

Do not copy this listener wrapper blindly to a different topology or a Caddy TLS listener. Validate the installed Caddy/HAProxy configurations, listener modules and ordering first. Preserve the private media-admission header and credential configuration without printing them. The listener behavior and trust boundary follow [Caddy's official PROXY protocol documentation](https://caddyserver.com/docs/caddyfile/options#proxy-protocol).

Back up both proxy configurations and the private application environment before changing them. Validate with `caddy validate` and `haproxy -c`, then test public HTTP/HTTPS/WSS, forged forwarding headers, distinct client addresses and direct-backend refusal. Injection tests passing in Fastify do not certify the deployed proxy chain. Retain the old configuration for rollback; never enable unrestricted proxy trust.
