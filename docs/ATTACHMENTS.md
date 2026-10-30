# Files and disk/traffic budgets

All sizes use **MiB = 1,048,576 bytes** and **GiB = 1,073,741,824 bytes**. The existing provider's 120 GB incoming allowance is a separate decimal/network billing quantity; the provider dashboard is authoritative.

| Rule | Limit |
| --- | --- |
| File size | 1 byte through 100 MiB; larger files rejected |
| Retention through 10 MiB inclusive | 7 days |
| Retention above 10 MiB | 24 hours |
| Registered account allowance | 300 MiB per rolling 24 hours |
| Instance normal allowance | 512 MiB per rolling 24 hours |
| After the normal allowance | Only files at most 2 MiB; total remains at most 1 GiB per rolling 24 hours |
| Guest uploads | Disabled |
| Resource bounds | Two incoming transfers and four outgoing transfers; at most 200 upload reservations/account/day |

The global 1 GiB limit **includes** the first 512 MiB. A large upload that would cross the soft limit is rejected, leaving the remaining allowance for small files. Reservations and per-user/global usage are committed in one bounded database transaction, including concurrent requests from different users. A canceled, invalid or interrupted reservation is not refunded: repeatedly canceling must not create unlimited incoming traffic. Retrying the same metadata request ID reuses its reservation. Allowance counters expire on a rolling basis, never at midnight.

These allowances do not guarantee staying under the provider's monthly limit. Voice and screens use the same incoming allocation. Continue reconciling the existing traffic monitor with the provider dashboard; no automatic top-up has been enabled.

## Storage and serving

The dedicated `ATTACHMENT_DIR` defaults to `DATA_DIR/attachments`. Only server-generated UUID `.part`/`.bin` paths are accessed. Filenames are metadata and never become filesystem paths. Supported extensions are text/Markdown/CSV/JSON, PDF, ZIP/7z, common images, and MP3/OGG/WAV/MP4/WebM. Selected binary signatures are checked; executables and active HTML/SVG are not supported. This is file validation and forced-download serving, not a malware-scanning service.

Transfers stream with bounded buffers. Downloads require current conversation membership and a nondeleted message, verify stored length/SHA256 before sending, and use `application/octet-stream`, attachment disposition, no-store, nosniff and a sandbox header. Guessing an identifier does not grant access. File contents are never rendered as application HTML. Android saves authorized downloads through a native streamed MediaStore implementation; physical-device acceptance remains a separate gate.

Expired files are removed first. When budget/free-space pressure requires it, older eligible ready files may be evicted before their nominal expiry. Existing messages retain metadata and show unavailable attachments. Active writers/readers are excluded. Bounded sweeps continue on the maintenance interval; an upload can be refused while sufficient eligible space is being reclaimed. No application, database, configuration or backup path is deleted. Missing/corrupt files return an unavailable response. A crash can leave `.part` files or ready bytes without a completed database update; stale reservations and generated-file orphans are reconciled in bounded scans.

Default attachment budget and free-space reserve are each 2 GiB. They are independently configurable through `.env.example`. Pending reservations count against the attachment budget and free-space admission calculation. Keep attachment data and its parent directory writable by the service user.

## Picture compression

JPEG/PNG/WebP pictures above 2 MiB and at most 25 MiB can be converted locally to a smaller WebP with a maximum 2560-pixel edge. Encoding quality steps down to target at most 2 MiB. The UI shows a preview and size comparison before the user chooses the compressed image or original. Conversion changes image bytes and strips metadata; it does not preserve the original file as an uploaded duplicate. Animated GIFs and unsupported/very large images retain the ordinary upload path rather than silently losing animation or allocating unbounded conversion work. If conversion is unavailable, normal backend limits still apply.

## Backup

Include the database, avatars, **attachments**, and private configuration in a coordinated stopped-service backup. An online SQLite snapshot alone does not capture filesystem attachment state atomically. Preserve a private off-host copy, validate SQLite, verify attachment checksums, and restore into an isolated instance before relying on a backup. Do not put conversations, files, private environment or exported data into Git/deployment ZIPs.

## Inline image and video previews (v0.4)

Chat now renders supported uploaded images and MP4/WebM video using authenticated, streamed preview responses; existing attachment metadata works unchanged. See [MEDIA-UPDATE.md](MEDIA-UPDATE.md) for supported formats, scoped preview grants, byte ranges, resource bounds and verification. The forced-download endpoint and all quotas/retention rules above remain in effect.
