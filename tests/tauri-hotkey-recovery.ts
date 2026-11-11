import { expect, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function proveHotkeyRecovery(page: Page, server: string, token: string, pid: number) {
  const response = await fetch(server + '/api/v1/servers', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ requestId: randomUUID(), name: 'Owned hotkey recovery' }),
  });
  expect(response.ok).toBe(true);
  await response.body?.cancel();
  await page.reload();
  const openRoom = page.getByRole('button', { name: 'Open Owned hotkey recovery', exact: true });
  await expect(openRoom).toBeVisible({ timeout: 15000 });
  await page.evaluate(`{
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true, value: () => {
        const audio = new AudioContext();
        const output = audio.createMediaStreamDestination();
        return Promise.resolve(output.stream);
      },
    });
    window.__hotkeyFixtureEvents = [];
    window.desktop.onVoiceHotkey(event => window.__hotkeyFixtureEvents.push(event.type));
  }`);

  const mode = (value: 'push' | 'toggle') => page.evaluate(value => {
    localStorage.setItem('dorham-voice-input', JSON.stringify({ mode: value, background: true, binding: { code: 'F9', ctrl: false, alt: false, shift: false } }));
    window.dispatchEvent(new Event('dorham-voice-input-changed'));
  }, value);
  const powerShell = (command: string) => exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true });
  const key = (down: boolean) => powerShell(`
    $ErrorActionPreference='Stop'
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class OwnedHotkeyFixture {
      [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
      [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
      [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
    }'
    if($${down}) {
      [uint32]$owner=0
      [void][OwnedHotkeyFixture]::GetWindowThreadProcessId([OwnedHotkeyFixture]::GetForegroundWindow(), [ref]$owner)
      if($owner -ne ${pid}) { throw 'The owned Dorham test window must be foreground to send F9' }
    }
    [OwnedHotkeyFixture]::keybd_event(120, 0, ${down ? 0 : 2}, [UIntPtr]::Zero)
  `);
  const stopHelper = () => powerShell(`
    $ErrorActionPreference='Stop'
    $helper=@(Get-CimInstance Win32_Process -Filter "Name='VoiceHotkey.exe' AND ParentProcessId=${pid}")
    if($helper.Count -ne 1) { throw 'Expected one owned hotkey helper' }
    Stop-Process -Id $helper[0].ProcessId -Force
  `);
  const readyCount = () => page.evaluate<number>("window.__hotkeyFixtureEvents.filter(event => event === 'ready').length");
  const released = page.getByRole('button', { name: 'Push to talk ready', exact: true });
  const muted = page.getByRole('button', { name: 'Unmute microphone', exact: true });
  const unmuted = page.getByRole('button', { name: 'Mute microphone', exact: true });

  await mode('push');
  await openRoom.click();
  await page.getByRole('button', { name: 'Lounge', exact: true }).click();
  try {
    await expect(released).toBeEnabled({ timeout: 15000 });
    await expect.poll(readyCount).toBe(1);
    await key(true);
    await expect(unmuted).toBeEnabled();
    await stopHelper();
    await expect(released).toBeEnabled();
    await expect.poll(readyCount).toBe(2);
    await expect(released).toBeEnabled();
    await key(false);
    await key(true);
    await expect(unmuted).toBeEnabled();
    await key(false);
    await expect(released).toBeEnabled();

    await mode('toggle');
    await expect(muted).toBeEnabled();
    await expect.poll(readyCount).toBe(3);
    await key(true);
    await expect(unmuted).toBeEnabled();
    await key(false);
    await stopHelper();
    await expect(muted).toBeEnabled();
    await expect.poll(readyCount).toBe(4);
    await key(true);
    await expect(unmuted).toBeEnabled();
    await key(false);
    await key(true);
    await expect(muted).toBeEnabled();
    console.log(JSON.stringify({ nativePushRecovered: true, nativeToggleRecovered: true, mutedOnFailure: true, heldKeyStayedMuted: true }));
  } finally {
    await key(false);
    await page.getByRole('button', { name: 'Disconnect voice', exact: true }).click().catch(() => {});
  }
}
