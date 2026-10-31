# Dorham emoji artwork

64 original user-supplied Soft Bubble SVGs from the dorham-icons pack, imported unchanged on 2026-10-31. Interface/filled icons are outside this release. The manifest retains source names, categories and search tags. The supplied Python geometry sources are preserved under source/.

Edit the SVGs directly, or run `python assets/dorham-emoji/source/rebuild.py` to regenerate them from the supplied emoji.py/core.py. Run `node scripts/emoji-assets.mjs` afterwards to update the hashed public directory and typed UI catalog. Normal dev/web builds run this step automatically. Only SVG image files are displayed; user message text never becomes SVG markup.

Messages store readable shortcodes such as :dorham-tea-time:. Existing clients show those codes as text. Registered reaction values are generated into shared contracts, retaining existing Unicode keys for historical counts.
