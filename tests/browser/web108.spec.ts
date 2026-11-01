import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { completeRecovery } from './recovery-helper';

test('switching English/Persian channels, servers and DMs keeps exactly one working composer', async ({ page, request }) => {
 const suffix=Date.now().toString().slice(-8),password='composer-fixture-password';
 const response=await request.post('/api/v1/auth/register',{headers:{'X-Dorham-Native':'1'},data:{username:'switcher'+suffix,displayName:'Switcher',password,requestId:randomUUID()}});expect(response.status()).toBe(201);const me=await response.json();
 async function api(path:string,body?:any,method=body?'POST':'GET'){const r=await request.fetch('/api/v1'+path,{method,headers:{Authorization:'Bearer '+me.accessToken},data:body?{requestId:randomUUID(),...body}:undefined});expect(r.ok(),await r.text()).toBe(true);return r.json();}
 const first=await api('/servers',{name:'Switch lab'});await api(`/servers/${first.id}/channels`,{name:'فارسی',kind:'text'});await api('/servers',{name:'Other lab'});
 const registered=await request.post('/api/v1/auth/register',{headers:{'X-Dorham-Native':'1'},data:{username:'friend'+suffix,displayName:'Friend',password,requestId:randomUUID()}});const friend=await registered.json();
 const dm=await api('/dms',{userId:friend.user.id});await api('/messages',{conversationId:dm.id,content:'Direct hello'});
 const errors:string[]=[];page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/');await page.getByLabel('Username',{exact:true}).fill(me.user.username);await page.getByLabel('Password',{exact:true}).fill(password);await page.getByRole('button',{name:'Let’s get you in',exact:true}).click();await completeRecovery(page);
 async function assertComposer(name:string){await expect(page.locator('.composer textarea')).toHaveCount(1);await expect(page.locator('.composer .mention-input')).toHaveCount(1);await expect(page.locator('.composer').getByRole('button',{name:'Add emoji',exact:true})).toHaveCount(1);await expect(page.getByRole('textbox',{name:'Message',exact:true})).toHaveAttribute('placeholder','Message '+name);}
 for(let i=0;i<6;i++){
  await page.getByRole('button',{name:'Open Switch lab',exact:true}).click();await page.getByRole('button',{name:'general',exact:true}).click();await assertComposer('#general');
  await page.getByRole('button',{name:'فارسی',exact:true}).click();await assertComposer('#فارسی');
  await page.getByRole('button',{name:'Open Other lab',exact:true}).click();await assertComposer('#general');
  await page.getByRole('button',{name:'Home',exact:true}).click();await page.locator('.dm-item').filter({hasText:'Friend'}).click();await assertComposer('Friend');
 }
 await page.getByRole('button',{name:'Open Switch lab',exact:true}).click();await page.getByRole('button',{name:'فارسی',exact:true}).click();
 const input=page.getByRole('textbox',{name:'Message',exact:true});await input.fill('سلام، یک پیام درست');await input.press('Enter');await expect(page.getByTestId('message').last()).toContainText('سلام، یک پیام درست');
 const channels=(await api('/bootstrap')).channels,fa=channels.find((c:any)=>c.serverId===first.id&&c.name==='فارسی');expect((await api(`/conversations/${fa.conversationId}/messages`)).messages.at(-1).content).toBe('سلام، یک پیام درست');
 await input.fill('@switch');await expect(page.getByRole('listbox',{name:'Tag a member'})).toBeVisible();await page.getByRole('option').first().click();await expect(input).toHaveValue('@'+me.user.username+' ');await input.fill('');
 await page.setViewportSize({width:390,height:844});await assertComposer('#فارسی');await input.fill('mobile message');await input.press('Enter');await expect(page.getByTestId('message').last()).toContainText('mobile message');
 expect(errors.filter(e=>/same key|Encountered two|NotFoundError|removeChild|insertBefore/i.test(e))).toEqual([]);
 await writeFile('artifacts/evidence/v108-composer-browser.json',JSON.stringify({repeatedSwitchCycles:6,channelsServersAndDms:true,oneComposerThroughout:true,persianSendCorrectConversation:true,mentionsWorkAfterSwitches:true,mobileSend:true,noReactKeyOrDomErrors:true},null,2));
});
