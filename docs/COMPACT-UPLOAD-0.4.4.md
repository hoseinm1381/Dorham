# Compact upload controls — 0.4.4

The attachment block is reduced to a 28px strip: a paperclip, the user's measured rolling 24-hour upload allowance, and an info disclosure. Expanded rules no longer take vertical space above every message composer. Compression review and pending attachments remain visible when needed. Clipboard paste and file attachment use the existing upload path.

The meter reads the existing authenticated `/api/v1/uploads/usage` endpoint. It shows server-accounted uploaded/reserved bytes against the user's 300 MiB allowance, not an estimate based on the current conversation or local files. Removing a file does not refund consumed daily allowance. Failed or cancelled upload attempts refresh usage too. Shared soft/hard limits continue to apply; known small-file-only or exhausted conditions are indicated, with full rules in the disclosure. Limits, retention, permissions and database schema are unchanged.

Usage refreshes on mount, after transfers, and on returning to a visible tab/window with a 30-second focus throttle. No periodic polling or media statistics collection is added. Unavailable usage is labelled rather than presented as zero. English/Persian and narrow-screen layout use logical positioning and native accessible progress/disclosure controls.

Validation uses the existing clipboard integration scenario with a real local backend/database: measured initial allowance, value after a real image upload, 28px collapsed height, disclosure behavior, clipboard/channel/DM delivery and four-file limit, plus Persian mobile disclosure bounds. Existing image compression review remains available. No production test accounts are needed. Android remains deferred; earlier heavy-media capacity and physical acoustic test limitations remain unchanged.

Release checks passed: lint, type checking, all 66 unit/API tests, API/web/desktop production builds, the updated clipboard/compact-meter browser scenario, and the large-image compression scenario. The installed unsigned Windows build also passed actual upload-usage values and compact geometry alongside its existing registration, media, profile/font/ping, credential isolation and lifecycle checks. This UI update does not repeat heavy media or background-key capacity tests.

Deployment preserved all 35 database tables, six real accounts, one server and sixteen messages. SQLite integrity and foreign keys are valid; schema, environment and quotas are unchanged. Existing application and coordinated private data/config backup are retained for rollback.
