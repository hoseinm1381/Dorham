import { expect, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { usePackagedListenOnly } from './tauri-test-microphone';

const run = promisify(execFile);

export async function proveOverlay(main: Page, server: string, token: string, displayName: string, pid: number) {
  const response = await fetch(server + '/api/v1/servers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ requestId: randomUUID(), name: 'Overlay qualification' }),
  });
  expect(response.ok).toBe(true);
  await response.body?.cancel();
  await main.reload();
  await usePackagedListenOnly(main);
  await main.getByRole('button', { name: 'Open Overlay qualification', exact: true }).click();
  const join = () => main.getByRole('button', { name: 'Lounge', exact: true }).click();
  const leave = () => main.getByRole('button', { name: 'Disconnect voice', exact: true }).click();
  const overlays = () => main.context().pages().filter(page => page.url() === 'https://localhost/overlay.html');
  const native = async (action: 'inspect' | 'lock' | 'unlock' = 'inspect') => {
    const { stdout } = await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.resolve('tests/fixtures/tauri-overlay-window.ps1'), String(pid), action,
    ], { windowsHide: true, timeout: 5000 });
    return stdout.trim() ? JSON.parse(stdout) : null;
  };
  const responsive = async () => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        main.evaluate(async () => (await window.desktop!.getAppInfo!()).version),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Desktop command stopped responding while updating the overlay')), 2500);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  };
  const configure = (values: boolean[]) => main.evaluate(async states => {
    for (const enabled of states) {
      await window.desktop!.configureOverlay!({ enabled, position: 'bottom-right' });
    }
  }, values);
  const assertShown = async () => {
    await expect.poll(() => overlays().length, { timeout: 15000 }).toBe(1);
    const overlay = overlays()[0];
    await expect(overlay.locator('.member .name')).toHaveText([displayName]);
    await expect(overlay.locator('.member .state')).toHaveAttribute('aria-label', /^(Muted|Listening)$/);
    await expect.poll(() => native(), { timeout: 6000 }).toEqual({ count: 1, visible: true, focused: false, noActivate: true, clickThrough: true });
    await responsive();
  };
  const assertClosed = async () => {
    await expect.poll(() => overlays().length, { timeout: 6000 }).toBe(0);
    await expect.poll(async () => (await native()).count, { timeout: 6000 }).toBe(0);
    await responsive();
  };

  await configure([false]);
  await join();
  await expect(main.locator('.gaming-voice')).toBeVisible();
  await expect(main.locator('.voice-panel')).toContainText('Listening only', { timeout: 20000 });
  await configure([true]);
  // The preference event triggers a renderer overlay update on a short timer.
  await expect.poll(async () => { await responsive(); return overlays().length; }, { timeout: 15000 }).toBe(1);
  await assertShown();
  const pickerOpened = main.context().waitForEvent('page', { timeout: 15000 });
  const share = main.evaluate(async () => {
    try {
      await window.desktop!.captureNativeVideo!({ width: 400, height: 220, fps: 15 }, false);
      return 'shared';
    } catch (error) { return (error as Error).name; }
  });
  void share.catch(() => {});
  const picker = await pickerOpened;
  await expect(picker).toHaveURL('https://localhost/capture-picker.html');
  await expect.poll(async () => (await native()).visible, { timeout: 6000 }).toBe(false);
  await picker.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(share).resolves.toBe('NotAllowedError');
  await assertShown();
  await configure([false]);
  await assertClosed();
  await configure([true, false, true, false, true, false]);
  await assertClosed();
  const creating = main.context().waitForEvent('page', { timeout: 15000 });
  await configure([true]);
  await creating;
  await configure([false]);
  await assertClosed();
  await configure([true]);
  await assertShown();
  await native('lock');
  await assertClosed();
  await native('unlock');
  await assertShown();
  await leave();
  await assertClosed();
  await join();
  await assertShown();
  await leave();
  await assertClosed();
  await configure([false]);
  console.log(JSON.stringify({ overlayDuringCall: true, hiddenDuringPicker: true, restoredAfterPicker: true, preferenceEvent: true, rapidToggle: true, rejoinEnabled: true, sameParticipant: true, desktopCommandsResponsive: true, clickThroughStyles: true, nonActivating: true, windowsSessionMessage: true }));
}
