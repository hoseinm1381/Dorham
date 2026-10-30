# Bundled Persian typography

Dorham bundles the unmodified Vazirmatn variable WOFF2 from the upstream v33.003 release. It is served by Dorham itself and cached with the public application shell, so Persian rendering needs no Google Fonts or other foreign CDN.

- Project and author notices: https://github.com/rastikerdar/vazirmatn
- Pinned source: https://github.com/rastikerdar/vazirmatn/blob/v33.003/fonts/webfonts/Vazirmatn%5Bwght%5D.woff2
- SHA-256: `4e3fa217d38fdafc1fea4414ceb58ca5e662cf0ab5fa735a8c8c20e8b42cad92`
- License: SIL Open Font License 1.1, included at `apps/web/public/licenses/Vazirmatn-OFL.txt` and served at `/licenses/Vazirmatn-OFL.txt` in web/Windows bundles.

The source filename is `apps/web/src/assets/Vazirmatn-Variable.woff2`. Font binaries are unmodified. Persian and English interface choices are retained; Persian message bytes, punctuation and half-spaces are preserved. Search normalization is applied only to comparisons, not stored content or display names.
