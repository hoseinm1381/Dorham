# Dorham 1.0.3 web update

Live at **https://dorhamapp.ir/**. Adds all 64 supplied Soft Bubble emojis, including the nine Dorham exclusives. Backend and stable Windows/Android releases remain 1.0.0; native builds remain deferred.

## Using emojis

The smile button beside the message box opens a searchable picker with All, Expressions, Reactions, Gaming and Only Dorham categories. English tags and localized Persian names are searchable. Choosing an emoji inserts its readable shortcode at the current caret or replaces the selected text; it does not send the message. Escape closes the picker and restores button focus. Search Enter does not send the draft. The 4000-character message limit applies to stored text, including shortcodes.

All registered shortcodes render as bundled SVG images inside channel and direct messages, including edited and reloaded history. Unknown shortcodes remain text; links retain their existing handling. Existing supported reactions use matching supplied art where available; this update does not expand server reaction values. Older clients display readable shortcodes until updated.

The supplied SVGs are copied unchanged, checked as static vector artwork, and accompanied by their editable Python geometry sources. All 64 generator outputs match the imported SVG bytes. Source assets are in assets/dorham-emoji; node scripts/emoji-assets.mjs prepares a content-hashed public asset folder and UI catalog. Dev and web builds run this step. The public PWA shell caches all 64 images for offline display without caching private API data. Interface/filled icons from the pack are outside this change.

## Verification

- Lint, TypeScript, production web build and 167 unit/API tests in 32 files pass. Focused checks cover mixed Persian/Unicode/unknown codes, escaped message markup, intact links, caret replacement, message length limits and localized/tag search.
- The isolated two-client browser scenario decodes all 64 SVG images, sends/edits messages, reloads message history, checks a DM history payload and an existing thumbs-up reaction, verifies caret selection and search Enter behavior, loads all 64 images offline, and checks Persian search plus picker bounds at 390 px. All nine Dorham-exclusive choices are reachable. Local test accounts/database are removed after the run.
- Browser memory stays within the existing 4 GiB combined limit. No new voice/media, native app, physical-device or capacity claim is made by this emoji update.

## Web rollout

A fresh private online rollback backup was downloaded and independently verified: 38 database table digests, eight stored files, 95 existing web files, SQLite integrity and foreign keys. Backup SHA-256: `aa1bdaad491fca7ce20c6740f720ea89052a007e2a8744f1ee08efb653739dc5`.

The web-only rollout changed 84 files and verified all 124 deployed files through local HTTP and normal public HTTPS/DNS, including every emoji SVG. Previous hashed assets are retained. All four services are active; the voice service PID/start identity is unchanged. No services were restarted and runtime/Caddy settings, database schema, backend package and stable native manifest are unchanged. Browser memory peaked at 2497.6 MiB combined. Rollout/public hash evidence is retained with artifacts/v1.0.3.

Refresh the web page to load 1.0.3, then select the smile button beside the message box. Windows/Android binaries will need a later rebuild to include the new picker.
