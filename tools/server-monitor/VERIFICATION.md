# Verification — 29 October 2026

Windows x64 portable release 1.0.0 was built and exercised against the existing Dorham Ubuntu VPS. Server operations were read-only SSH collection; no agent installation, service/configuration change, chat account or test room was needed.

## Passed

- .NET build and self-contained single-file publish; pinned NuGet graph restores in locked mode.
- 16 focused checks: CPU deltas, first sample, nonpositive time, reboot/counter/interface resets, network rates, unavailable values, Windows DPAPI round trip, fingerprint validation and polling bounds.
- Packaged executable read two actual server samples, with CPU/network deltas, root filesystem capacity, available RAM, all four service readings, and the existing incoming-traffic counter.
- A real SSH handshake with an intentionally incorrect fingerprint was rejected.
- Packaged UI checks: live resource cards, network tab, populated connection form, simulated interruption of only the monitor's SSH session, cleared unavailable readings, automatic reconnect, manual disconnect/reconnect, and rendering at minimum window size. Nine real samples were received during this scenario.
- Actual screenshots inspected for dashboard, connection settings and compact layout; no generated/demo measurements were used. The final dashboard screenshot comes from a fresh live session.
- Source, executable, ZIP contents and saved profile checked against the existing server password: no plaintext password in source/distribution/profile; profile contains only a Windows-user-encrypted password.
- NuGet vulnerability query reported no known vulnerable packages from the configured NuGet source at build time.

Evidence: `D:/Dorham/artifacts/server-monitor/evidence/` (`self-test.json`, `live-probe.json`, `ui-checks.json`, `secret-scan.json`, and PNG screenshots). The screenshot-heavy diagnostic process has a larger working set than normal monitoring; its recorded memory is not a normal-use benchmark.

## Release

- EXE: `D:/Dorham/artifacts/server-monitor/windows-x64/Dorham Monitor.exe`
- EXE SHA256: `7CE0E2B0DC3997FA69B98362C6682B8A6650F3C617164A5BF7B69C77055E7410`
- Portable ZIP: `D:/Dorham/artifacts/server-monitor/Dorham-Monitor-1.0.0-Windows-x64.zip`
- ZIP SHA256: `AE378FCD1D7E9D4E94AD8D36AA244ADC68D4565467254CE5A83D12BF5BCB29C0`

The current Windows user's encrypted profile is configured from the previously saved operator credential and trusted host key. Credentials are not part of the release. The build is unsigned. Other PCs, SSH key-based authentication, tray/background notifications, long-duration reliability, and disk I/O/physical-drive health are not verified/implemented by this release. Root-drive capacity is implemented and live-tested. No Git commit, push or remote application deployment was performed by this work.
