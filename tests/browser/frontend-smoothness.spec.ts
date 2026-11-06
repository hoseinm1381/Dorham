import { expect, test, type Page } from '@playwright/test';
import { completeRecovery } from './recovery-helper';

async function register(page: Page, name: string) {
  await page.goto('/'); await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await page.getByLabel('Display name', { exact: true }).fill(name); await page.getByLabel('Username', { exact: true }).fill(name);
  await page.getByLabel('Password', { exact: true }).fill('frontend-fixture-password');
  await page.getByRole('button', { name: 'Create account', exact: true }).click(); await completeRecovery(page);
}
async function api(page: Page, route: string, body?: object) {
  return page.evaluate(async ({ route, body }) => {
    const auth = await (await fetch('/api/v1/auth/me')).json();
    const response = await fetch('/api/v1' + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': auth.csrf }, body: body ? JSON.stringify({ requestId: crypto.randomUUID(), ...body }) : undefined });
    if (!response.ok) throw Error(await response.text()); return response.json();
  }, { route, body });
}
async function anchor(page: Page) {
  return page.locator('.message-scroll').evaluate(root => {
    const box = root.getBoundingClientRect();
    const item = [...root.querySelectorAll<HTMLElement>('[data-history-id]')].find(el => el.getBoundingClientRect().bottom > box.top + 1)!;
    return { id: item.dataset.historyId, offset: item.getBoundingClientRect().top - box.top };
  });
}
test('history anchors survive row growth, prepend and incoming messages before jumping to latest', async ({ page }) => {
  await register(page, 'Anchor' + Date.now().toString().slice(-8));
  const server = await api(page, '/servers', { name: 'Anchor lab' });
  const channel = (await api(page, '/bootstrap')).channels.find((c: any) => c.serverId === server.id && c.kind === 'text');
  for (let i = 0; i < 120; i++) await api(page, '/messages', { conversationId: channel.conversationId, content: `Anchor ${i} ` + (i % 5 ? 'ordinary row' : 'سلام یک پیام بلند '.repeat(30)) });
  await page.getByRole('button', { name: 'Open Anchor lab', exact: true }).click();
  await expect(page.getByTestId('message').last()).toContainText('Anchor 119');
  await page.waitForTimeout(600);
  await page.locator('.message-scroll').evaluate(root => { root.scrollTop = (root.scrollHeight - root.clientHeight) * 0.45; });
  await page.waitForTimeout(400); const before = await anchor(page);
  await page.locator('.message-scroll').evaluate(root => {
    const top = root.getBoundingClientRect().top;
    const above = [...root.querySelectorAll<HTMLElement>('[data-history-id]')].filter(el => el.getBoundingClientRect().bottom <= top).at(-1)!;
    const delayed = document.createElement('div'); delayed.style.height = '80px'; above.append(delayed);
  });
  await page.waitForTimeout(400); let after = await anchor(page);
  expect(after.id).toBe(before.id); expect(Math.abs(after.offset - before.offset)).toBeLessThan(3);
  await page.getByRole('button', { name: 'Load earlier messages', exact: true }).dispatchEvent('click');
  await page.waitForTimeout(500); after = await anchor(page);
  expect(after.id).toBe(before.id); expect(Math.abs(after.offset - before.offset)).toBeLessThan(3);
  await api(page, '/messages', { conversationId: channel.conversationId, content: 'Newest anchor message' });
  await page.waitForTimeout(500); after = await anchor(page);
  expect(after.id).toBe(before.id); expect(Math.abs(after.offset - before.offset)).toBeLessThan(3);
  await page.getByRole('button', { name: 'New messages · Jump to latest', exact: true }).click();
  await expect(page.getByTestId('message').last()).toContainText('Newest anchor message');
  await expect(page.getByTestId('message').last()).toBeVisible();
});

test('speaking subscriptions follow decoded audio, silence and mute without losing the conversation draft', async ({ browser }) => {
  const a = await browser.newContext({ permissions: ['microphone'] }), b = await browser.newContext({ permissions: ['microphone'] });
  const sender = await a.newPage(), receiver = await b.newPage(), name = 'Speaker' + Date.now().toString().slice(-8);
  try {
    await sender.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        const context = new AudioContext(); await context.resume();
        const tone = context.createOscillator(), gain = context.createGain(), output = context.createMediaStreamDestination();
        tone.frequency.value = 440; gain.gain.value = 0.03; tone.connect(gain).connect(output); tone.start();
        (window as any).__smoothnessTone = gain;
        output.stream.getAudioTracks()[0].addEventListener('ended', () => { tone.stop(); void context.close(); }); return output.stream;
      };
    });
    await register(sender, name); await register(receiver, 'Listener' + Date.now().toString().slice(-8));
    const server = await api(sender, '/servers', { name: 'Speaking lab' }), invite = await api(sender, `/servers/${server.id}/invites`, {});
    await api(receiver, '/invites/join', { code: invite.code });
    for (const page of [sender, receiver]) { await page.getByRole('button', { name: 'Open Speaking lab', exact: true }).click(); await page.getByRole('button', { name: 'Lounge', exact: true }).click(); }
    const speaker = receiver.locator('.voice-mini-members button').filter({ hasText: name });
    await expect(speaker).toHaveClass(/speaking/, { timeout: 30000 });
    await expect(speaker.locator('.avatar')).toHaveCSS('outline-style', 'solid');
    await expect(speaker.locator('.avatar')).toHaveCSS('outline-color', 'rgba(131, 218, 186, 0.4)');
    const draft = receiver.getByRole('textbox', { name: 'Message', exact: true }); await draft.fill('Keep this draft during audio updates');
    await sender.evaluate(() => { (window as any).__smoothnessTone.gain.value = 0; }); await expect(speaker).not.toHaveClass(/speaking/);
    await sender.evaluate(() => { (window as any).__smoothnessTone.gain.value = 0.03; }); await expect(speaker).toHaveClass(/speaking/);
    await sender.getByRole('button', { name: 'Mute microphone', exact: true }).click(); await expect(speaker).not.toHaveClass(/speaking/);
    await sender.getByRole('button', { name: 'Unmute microphone', exact: true }).click(); await expect(speaker).toHaveClass(/speaking/);
    await expect(draft).toHaveValue('Keep this draft during audio updates');
  } finally { await a.close(); await b.close(); }
});
