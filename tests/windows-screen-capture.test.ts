import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { captureScreen, setDesktopCaptureCapabilities } from '../packages/media/src/screen-capture';
const { trustedCaptureRequest } = createRequire(import.meta.url)('../apps/desktop/capture-origin.cjs');
afterEach(() => { vi.unstubAllGlobals(); setDesktopCaptureCapabilities({ sharedAudio: false }); });
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

it('captures only the source selected in the Windows 10 picker, without requiring sound', async () => {
  const stream = { getVideoTracks: () => [] };
  const getUserMedia = vi.fn().mockResolvedValue(stream), getDisplayMedia = vi.fn();
  const choose = vi.fn().mockResolvedValue({ sourceId: 'screen:0:0' });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia, getDisplayMedia } });
  vi.stubGlobal('desktop', { chooseCompatibilitySource: choose });
  setDesktopCaptureCapabilities({ sharedAudio: false, compatibilityVideo: true });
  const settings = { width: 1280, height: 720, fps: 15 };
  expect(await captureScreen(settings, false)).toBe(stream);
  expect(getUserMedia).toHaveBeenCalledWith({ audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: 'screen:0:0', maxWidth: 1280, maxHeight: 720, maxFrameRate: 15 } } });
  expect(getDisplayMedia).not.toHaveBeenCalled();
  choose.mockResolvedValue(null);
  await expect(captureScreen(settings, false)).rejects.toMatchObject({ name: 'NotAllowedError' });
  expect(getUserMedia).toHaveBeenCalledOnce();
});
