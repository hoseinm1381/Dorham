import type { Page } from '@playwright/test';

export async function usePackagedListenOnly(page: Page) {
  if (process.env.DORHAM_TEST_PACKAGED_PROFILE !== '1') return;
  await page.evaluate(`{
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: () => Promise.reject(new DOMException('Fixture listen-only mode', 'NotAllowedError')),
    });
  }`);
}
