# Dorham Monitor

A separate Windows dashboard and administration app for Dorham. Use **Overview** for SSH telemetry and **People** for account actions, rank badges, and individual feature grants. **Server tools** holds instance-wide policies and content.

## Open

Run **Dorham Monitor.exe** from the versioned output directory printed by the build, or extract the corresponding portable ZIP. The title bar shows the version of the running build. The x64 build includes its .NET runtime. The executable is unsigned. Closing the window exits the monitor.

The existing VPS connection is configured for the current Windows account during development. Other Windows users or computers must enter their own connection in **Connection**. Credentials are never bundled into the executable or ZIP. Moving the app does not move its saved credentials.

## Dashboard

- CPU: aggregate Linux CPU usage between two samples, excluding idle and I/O-wait. The first reading says Sampling. One-minute load average appears below it.
- RAM: total minus MemAvailable, which accounts for reclaimable cache. Values use binary GiB/MiB.
- Drive: used blocks on the root filesystem `/`, total size, and space available to ordinary users. Reserved blocks can make used plus available slightly smaller than total. This is capacity, not disk read/write throughput or drive-health testing.
- Resource chart: CPU + RAM or receiving/sending network rates, kept in memory for up to five minutes in the current window. Short gaps, reconnects and reboots do not produce false spikes. History is not saved across app launches.
- Services: Dorham, LiveKit, Caddy and HAProxy status and service-group memory. Hover over a memory reading for that service's share of server CPU. Unknown values stay unavailable.
- Network: the default-route interface only, avoiding duplicate Docker/bridge accounting. Rates are bytes per second. Sample round-trip includes SSH, Python and systemctl work; it is not a pure network ping.
- Traffic allowance: the existing `/var/lib/dorham-ops/traffic.json` estimate, including its setup reserve, in decimal GB. Readings older than five minutes are marked stale. The provider dashboard remains the billing authority. No traffic purchase, renewal or service shutdown is performed.

High usage and service alerts appear in the banner while the app is open. Thresholds: CPU 90%, RAM/drive 85%, traffic allowance 80%, or an expected service not active. Connection failures always remain visible. No notification sound or background Windows notification is implemented.

## Users

Open **Users** and sign in with your **Dorham global administrator account**, using the HTTPS address of the intended instance (default `https://dorhamapp.ir`). This is separate from the SSH credentials and does not require the monitor to be connected. Standard Windows HTTPS certificate validation applies; redirects and plaintext HTTP endpoints are refused. The app neither creates nor claims an administrator account.

Search the user list and select an account. Ban, unban, sign out devices, and generate a temporary password use existing backend endpoints. Each write requires an explicit confirmation. Global administrator accounts are protected, and guest accounts cannot receive passwords. Generated passwords are hidden until Reveal; dismissing them, changing the selection, or leaving Users clears them. Selecting and copying a revealed password uses the ordinary Windows clipboard, which the app does not manage.

**Set password** and **Delete account** become available when the connected Go backend advertises them. A chosen password is temporary and must be replaced at next sign-in. Deletion requires typing the exact username. Messages and their attachments stay under **Deleted account**. Existing direct chats become read-only for the other participant, and owned servers transfer to the acting administrator.

The administrator password, access token, and generated password are kept only in memory, never in the saved SSH profile or diagnostic receipts. Native sessions expire after 15 minutes; sign in again when asked. Sign out revokes the current session. Closing attempts logout without delaying shutdown; if the server cannot be reached, server-side session expiry still applies. Monitoring continues independently. A network timeout can occur after an action succeeds, so writes are never automatically retried; refresh and check the account before trying again.

Legacy backends return at most 250 users. The monitor displays a notice if that limit is reached, and fetches additional pages only when the backend advertises pagination. No new backend feature is enabled based on client-side permissions alone.

## Connection and security

Enter the SSH host, port, username, password, and trusted **SHA256 host-key fingerprint**. Use the existing trusted SSH connection or provider console to verify that fingerprint. The app refuses a mismatched key before password authentication; it never auto-trusts a new key. This version supports SSH password authentication only.

The profile lives at `%LOCALAPPDATA%\Dorham Monitor\connection.json`. Windows DPAPI encrypts the password for the current Windows account. The app must decrypt it in memory to authenticate. Host, username, preferences and fingerprint are ordinary profile metadata. There is no third-party telemetry, cloud account or password in source/build artifacts.

Default refresh is every three seconds after the previous sample completes; choose 2–60 seconds in Connection. One SSH session is reused. Network failures retry with a bounded 5–30 second delay. Authentication failures and host-key mismatches stop automatic retries until you disconnect, correct settings and reconnect. Lost readings are cleared immediately rather than presented as live. Settings do not modify the server.

The embedded collector requires Python 3, Linux `/proc`, `statvfs`, and `systemctl` on the VPS. It executes a fixed read-only script in memory through SSH. It does not upload files, install an agent, use sudo, restart services or change configuration. The existing operator credential can access these readings; a dedicated restricted monitoring account is a future hardening option, and no account is created automatically.

## Build

Use a .NET SDK supporting `net8.0-windows`, on Windows:

```powershell
dotnet build tools/server-monitor/Dorham.Monitor.csproj -c Release
powershell -ExecutionPolicy Bypass -File tools/server-monitor/Build.ps1 -Portable
```

Build inputs are in this folder, including the SVG and ICO icon. NuGet dependencies are pinned in the project and lockfile. The app uses the installed SDK's available .NET 8 runtime patch when publishing; maintain that runtime with future builds.

Read-only checks (run using the app executable):

```powershell
& '.\Dorham Monitor.exe' --self-test 'C:\path\self-test.json'
& '.\Dorham Monitor.exe' --probe 'C:\path\live-probe.json'
& '.\Dorham Monitor.exe' --capture 'C:\path\dashboard.png'
& '.\Dorham Monitor.exe' --ui-test 'C:\path\ui-evidence'
& '.\Dorham Monitor.exe' --admin-ui-test 'C:\path\offline-admin-ui-evidence'
```

`--self-test` checks telemetry calculations, synthetic DPAPI encryption and the admin client with fake HTTP responses. `--admin-ui-test` renders and exercises the actual Users controls using synthetic data and an in-memory fake transport, including confirmations, password reveal/clearing, search, and sign-out. It does not load the saved connection or contact the server. `--probe` reads two real server samples, checks rates/service availability, and proves rejection of an intentionally incorrect host key. `--capture` renders the actual dashboard after five live samples and exits. `--ui-test` exercises live cards, the network tab, connection form, disconnect, reconnect, and minimum window size, writing screenshots and a receipt. These commands do not mutate the server. `--configure PRIVATE_JSON SHA256_FINGERPRINT` explicitly imports an existing local `{host, username, password}` file into this Windows user's encrypted profile, without copying it into the app. Do not distribute private input files. CLI errors produce a nonzero exit and a short local `last-error.txt` when the profile folder is writable. A successful live probe does not establish long-duration stability or testing on other Windows machines.

Primary implementation references: [SSH.NET host-key verification](https://sshnet.github.io/SSH.NET/examples.html), [Microsoft single-file publishing](https://learn.microsoft.com/en-us/dotnet/core/deploying/single-file/overview).
