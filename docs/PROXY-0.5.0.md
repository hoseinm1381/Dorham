# Deployed proxy trust — Dorham 0.5.0

Applied and checked on 30 October 2026. The pilot uses existing HAProxy 2.8 and Caddy 2.6.2; its Caddy has no PROXY-protocol listener module. No new module or runtime dependency was installed.

HTTPS is terminated by HAProxy. Website/voice HTTP then passes through a second, loopback-only HAProxy HTTP listener before reaching loopback Caddy and the backend. TURN keeps its existing separate raw-TCP route. Plain HTTP enters HAProxy's existing HTTP frontend directly.

The TLS website backend forwards the socket address to the private HTTP listener:

```haproxy
backend caddy_tcp
  server local 127.0.0.1:8081 send-proxy-v2

listen caddy_client_address
  bind 127.0.0.1:8081 accept-proxy
  mode http
  timeout tunnel 1h
  http-request del-header Forwarded
  http-request set-header X-Forwarded-Host %[req.hdr(host)]
  http-request set-header X-Forwarded-For %[src]
  http-request set-header X-Real-IP %[src]
  http-request set-header X-Forwarded-Proto https
  server local 127.0.0.1:8080
```

The public port-80 HTTP frontend applies the same canonical headers, with proto `http`. The PROXY header is accepted only at the loopback listener; public sockets do not accept client-supplied PROXY headers. HAProxy's address forwarding and header rules follow its [versioned configuration reference](https://docs.haproxy.org/2.8/configuration.html).

Caddy remains bound to loopback 8080. Its application route preserves only the address/protocol metadata normalized by HAProxy:

```caddyfile
reverse_proxy 127.0.0.1:3001 {
    header_up X-Forwarded-For {http.request.header.X-Forwarded-For}
    header_up X-Real-IP {http.request.header.X-Forwarded-For}
    header_up X-Forwarded-Proto {http.request.header.X-Forwarded-Proto}
}
```

This uses Caddy's [request-header handling](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#headers), validated on the installed binary. The private media-admission header and redaction rules remain intact. The application binds to 127.0.0.1:3001 and trusts only `TRUSTED_PROXIES=127.0.0.1/32`. Local machine administration remains inside the trust boundary. Do not expose Caddy, the intermediate listener or the backend publicly, copy this header-pass configuration to an untrusted ingress, or enable unrestricted proxy trust.

Release checks validated both configurations before applying them. A real public request with spoofed forwarding metadata reached the backend with the original client address; two synthetic PROXY clients received independent budgets, and the first exhausted its own budget without exhausting the second. Public HTTPS/WSS plus forced TURN/TLS decoded media also pass. These checks do not certify the failed ten-user media capacity gate.

Before future changes, retain private copies of both proxy configurations, certificates and application environment. Validate with `caddy validate` and `haproxy -c`, then check HTTPS, upgrades, canonical headers and direct-backend refusal. Never print or publish the actual media-admission header or private backup. The pre-0.5.0 configuration and application remain retained for rollback.
