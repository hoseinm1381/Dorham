import { completeRecovery } from './recovery-helper';
import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
async function register(page: Page, name: string) {
  await page.goto('/'); await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await page.getByLabel('Display name', { exact: true }).fill(name); await page.getByLabel('Username', { exact: true }).fill(name); await page.getByLabel('Password', { exact: true }).fill('Member-invite-fixture');
  await page.getByRole('button', { name: 'Create account', exact: true }).click(); await completeRecovery(page); await expect(page.locator('.app')).toBeVisible();
}
async function api(page: Page, route: string, body: object) {
  return page.evaluate(async ({ route, body }) => {
    const auth = await (await fetch('/api/v1/auth/me')).json();
    const response = await fetch('/api/v1' + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': auth.csrf }, body: JSON.stringify({ requestId: crypto.randomUUID(), ...body }) });
    if (!response.ok) throw new Error(`API ${response.status}`); return response.json();
  }, { route, body });
}
test('members create and copy their own links; only the owner can disable member invitations live', async ({ browser }) => {
  const ownerContext = await browser.newContext(), memberContext = await browser.newContext();
  const owner = await ownerContext.newPage(), member = await memberContext.newPage();
  try {
    const suffix = Date.now().toString().slice(-7); await register(owner, `InviteOwner${suffix}`); await register(member, `InviteMember${suffix}`);
    const server = await api(owner, '/servers', { name: 'Invite lab' }), seed = await api(owner, `/servers/${server.id}/invites`, {});
    await api(member, '/invites/join', { code: seed.code });
    for (const page of [owner, member]) await page.getByRole('button', { name: 'Open Invite lab', exact: true }).click();
    await member.getByRole('button', { name: 'Invite people', exact: true }).click();
    const dialog = member.getByRole('dialog'); await expect(dialog.getByRole('checkbox', { name: 'Allow members to create invite links', exact: true })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Create invite link', exact: true }).click(); await expect(dialog.getByLabel('Invite link', { exact: true })).toHaveCount(1);
    const value = await dialog.getByLabel('Invite link', { exact: true }).inputValue(); expect(value).toContain('?invite='); expect(value).not.toContain(seed.code);
    await expect(dialog.getByRole('button', { name: 'Copy invite', exact: true })).toBeEnabled();
    await owner.getByRole('button', { name: 'Invite people', exact: true }).click();
    const enabled = owner.getByRole('checkbox', { name: 'Allow members to create invite links', exact: true }); await expect(enabled).toBeChecked();
    await mkdir('artifacts/evidence', { recursive: true });
    await owner.screenshot({ path: 'artifacts/evidence/v052-owner-invites.png' }); await member.screenshot({ path: 'artifacts/evidence/v052-member-invites.png' });
    await enabled.uncheck(); await expect(member.getByRole('button', { name: 'Invite people', exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Create invite link', exact: true })).toHaveCount(0);
    await enabled.check(); await expect(dialog.getByRole('button', { name: 'Create invite link', exact: true })).toBeVisible();
    await expect(dialog.getByLabel('Invite link', { exact: true })).toHaveValue(value);
  } finally { await ownerContext.close(); await memberContext.close(); }
});
