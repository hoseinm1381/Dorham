import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { completeRecovery } from './recovery-helper';
test.use({ trace: 'off' });
test('right-click moderation, peer-admin drag moves, timeout and ban work through real clients', async ({ browser, request }) => {
 const suffix=Date.now().toString().slice(-8), password='moderation-browser-fixture';
 async function account(name:string){const r=await request.post('/api/v1/auth/register',{headers:{'X-Dorham-Native':'1'},data:{username:name+suffix,displayName:name,password,requestId:randomUUID()}});expect(r.status()).toBe(201);return r.json();}
 const owner=await account('Owner'), admin=await account('Admin'), peer=await account('Peer');
 async function api(u:any,path:string,body?:any,method='POST'){const r=await request.fetch('/api/v1'+path,{method,headers:{Authorization:'Bearer '+u.accessToken},data:body===undefined?undefined:{requestId:randomUUID(),...body}});expect(r.ok(),await r.text()).toBe(true);return r.json();}
 const server=await api(owner,'/servers',{name:'Moderation lab'}), invite=await api(owner,`/servers/${server.id}/invites`,{});
 for(const u of [admin,peer]){await api(u,'/invites/join',{code:invite.code});await api(owner,`/servers/${server.id}/members/${u.user.id}`,{role:'administrator'},'PATCH');}
 await api(owner,`/servers/${server.id}/channels`,{name:'Game 2',kind:'voice'});
 const a=await browser.newContext(),b=await browser.newContext(),page=await a.newPage(),other=await b.newPage();
 async function login(p:Page,name:string){await p.goto('/');await p.getByLabel('Username',{exact:true}).fill(name+suffix);await p.getByLabel('Password',{exact:true}).fill(password);await p.getByRole('button',{name:'Let’s get you in',exact:true}).click();await completeRecovery(p);await p.getByRole('button',{name:'Open Moderation lab',exact:true}).click();}
 try{
  page.setDefaultTimeout(15000);other.setDefaultTimeout(15000);
  await login(page,'Admin');await login(other,'Peer');await other.getByRole('button',{name:'Lounge',exact:true}).click();await expect(other.locator('.gaming-voice')).toBeVisible();
  const peerRow=()=>page.locator('.member-row').filter({has:page.getByText('Peer',{exact:true})});
  await peerRow().click({button:'right'});const menu=page.getByRole('menu',{name:'Member actions',exact:true});await expect(menu.getByRole('menuitem',{name:'Move to voice channel',exact:true})).toBeVisible();await expect(menu.getByRole('menuitem',{name:'Ban from server',exact:true})).toHaveCount(0);await expect(menu.getByRole('menuitem',{name:'Disconnect from voice',exact:true})).toHaveCount(0);await page.keyboard.press('Escape');
  await page.locator('.voice-mini-members button').filter({has:page.getByText('Peer',{exact:true})}).dragTo(page.getByRole('button',{name:'Game 2',exact:true}));
  await expect(other.locator('.gaming-voice-header strong')).toHaveText('Game 2');
  await expect(page.locator('.voice-mini-members button').filter({has:page.getByText('Peer',{exact:true})})).toBeVisible();
  // Demote the target through the owner API, then exercise the actual menu actions.
  await api(owner,`/servers/${server.id}/members/${peer.user.id}`,{role:'member'},'PATCH');
  await peerRow().click({button:'right'});await expect(menu.getByRole('menuitem',{name:'Time out member',exact:true})).toBeVisible();await page.screenshot({path:'artifacts/evidence/v107-member-menu.png'});await menu.getByRole('menuitem',{name:'Time out member',exact:true}).click();
  const confirm=page.getByRole('dialog',{name:'Confirm moderation action',exact:true});await confirm.getByLabel('Timeout duration',{exact:true}).selectOption('60');await confirm.screenshot({path:'artifacts/evidence/v107-timeout-confirmation.png'});await confirm.getByRole('button',{name:'Apply timeout',exact:true}).click();
  await expect(other.locator('.gaming-voice')).toHaveCount(0);await expect(other.getByLabel('Message',{exact:true})).toBeDisabled();await expect(other.getByRole('status').filter({hasText:'You are timed out until'})).toBeVisible();
  await peerRow().click({button:'right'});await menu.getByRole('menuitem',{name:'Remove timeout',exact:true}).click();await expect(other.getByLabel('Message',{exact:true})).toBeEnabled();
  // Copy the exact stored message through the desktop action toolbar.
  await page.addInitScript(()=>{Object.defineProperty(navigator,'clipboard',{value:{writeText:async(text:string)=>{(window as any).__copied=text;}}});});
  await page.evaluate(()=>{Object.defineProperty(navigator,'clipboard',{value:{writeText:async(text:string)=>{(window as any).__copied=text;}}});});
  await page.getByLabel('Message',{exact:true}).fill('Copy this سلام');await page.getByRole('button',{name:'Send message',exact:true}).click();const message=page.getByTestId('message').filter({hasText:'Copy this سلام'});await message.hover();await message.getByRole('button',{name:'Copy message text',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).__copied)).toBe('Copy this سلام');
  await peerRow().click({button:'right'});await menu.getByRole('menuitem',{name:'Ban from server',exact:true}).click();await confirm.getByLabel('Reason (optional)',{exact:true}).fill('Browser test');await confirm.getByRole('button',{name:'Confirm ban',exact:true}).click();await expect(other.getByRole('button',{name:'Open Moderation lab',exact:true})).toHaveCount(0);
  const blocked=await request.post('/api/v1/invites/join',{headers:{Authorization:'Bearer '+peer.accessToken},data:{code:invite.code,requestId:randomUUID()}});expect(blocked.status()).toBe(403);
  await page.locator('.space-heading').click();await page.locator('.manage-server .tabs').getByRole('button',{name:'members',exact:true}).click();await page.getByText('Server bans',{exact:true}).click();await expect(page.locator('.server-ban-list')).toContainText('Browser test');await page.getByRole('button',{name:'Unban',exact:true}).click();await expect(page.getByText('No banned members.',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Close dialog',exact:true}).click();await api(peer,'/invites/join',{code:invite.code});
  await page.screenshot({path:'artifacts/evidence/v107-moderation-browser.png'});
  await page.getByRole('button',{name:'Account settings',exact:true}).click();await page.getByLabel('Language',{exact:true}).selectOption('fa-IR');await expect(page.locator('html')).toHaveAttribute('dir','rtl');await page.getByRole('button',{name:'بستن پنجره',exact:true}).click();
  await expect(peerRow()).toBeVisible();const viewport=page.viewportSize()!;await peerRow().dispatchEvent('contextmenu',{clientX:viewport.width-2,clientY:viewport.height-2});const rtlMenu=page.getByRole('menu',{name:'گزینه‌های عضو',exact:true});await expect(rtlMenu.getByRole('menuitem',{name:'مسدود کردن در سرور',exact:true})).toBeVisible();await expect.poll(async()=>{const box=await rtlMenu.boundingBox();return !!box&&box.x>=8&&box.y>=8&&box.x+box.width<=viewport.width-7&&box.y+box.height<=viewport.height-7;}).toBe(true);await page.screenshot({path:'artifacts/evidence/v107-member-menu-rtl.png'});await page.keyboard.press('Escape');await expect(rtlMenu).toHaveCount(0);
  await writeFile('artifacts/evidence/v107-moderation-browser.json',JSON.stringify({realClients:2,peerAdminMenuOnlyMoves:true,actualHtmlDragDrop:true,targetClientChangedVoice:true,timeoutDisconnectedAndBlockedComposer:true,removeTimeoutRestoredComposer:true,serverBanRemovedAccessAndBlockedInvite:true,unbanUiRestoredJoin:true,desktopCopyExactText:true,persianRtlAndViewportClamping:true,escapeDismissedMenu:true,backendServerId:server.id,fixtureOnly:true},null,2));
 }finally{await a.close();await b.close();}
});
