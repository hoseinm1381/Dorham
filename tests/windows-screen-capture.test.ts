import { expect, it } from 'vitest';
import { createRequire } from 'node:module';
const { trustedCaptureRequest } = createRequire(import.meta.url)('../apps/desktop/capture-origin.cjs');
function fixture() {
  const frame = { url: 'dorham://app/index.html', detached: false };
  const contents = { mainFrame: frame, isDestroyed: () => false };
  return { frame, contents, request: { frame, securityOrigin: 'dorham://app/' } };
}
it('accepts Electron custom-scheme capture origins with or without the trailing slash', () => {
  const { request, contents } = fixture();
  expect(trustedCaptureRequest(request, contents)).toBe(true);
  expect(trustedCaptureRequest({ ...request, securityOrigin: 'dorham://app' }, contents)).toBe(true);
});
it('rejects foreign and lookalike origins instead of widening capture access', () => {
  const { request, contents } = fixture();
  for (const securityOrigin of ['https://app/', 'dorham://app.evil/', 'dorham://app@evil/', 'dorham://app:3000/', 'dorham://app/other', 'null', '']) {
    expect(trustedCaptureRequest({ ...request, securityOrigin }, contents)).toBe(false);
  }
});
it('requires the live trusted main frame even when the supplied origin matches', () => {
  const { request, contents, frame } = fixture();
  expect(trustedCaptureRequest({ ...request, frame: { ...frame } }, contents)).toBe(false);
  expect(trustedCaptureRequest({ ...request, frame: null }, contents)).toBe(false);
  expect(trustedCaptureRequest(request, undefined)).toBe(false);
  expect(trustedCaptureRequest(request, { ...contents, isDestroyed: () => true })).toBe(false);
  frame.detached = true;
  expect(trustedCaptureRequest(request, contents)).toBe(false);
  frame.detached = false; frame.url = 'https://example.invalid/';
  expect(trustedCaptureRequest(request, contents)).toBe(false);
});
