import { it, expect } from 'vitest';
import { releaseFile, newerVersion, RELEASE_ORIGIN } from '../packages/contracts/src/releases';
const file = { version: '1.0.1', url: RELEASE_ORIGIN + '/downloads/1.0.1/Dorham-1.0.1-Windows-x64.exe', appId: 'com.dorham.chat', sha256: 'a'.repeat(64), size: 4096 };
const manifest = { schema: 1, version: '1.0.1', windows: file };
it('compares release numbers numerically and never suggests downgrades or malformed versions', () => {
  expect(newerVersion('1.0.0', '0.7.7')).toBe(true); expect(newerVersion('1.10.0', '1.9.9')).toBe(true);
  for (const v of ['1.0.0', '0.9.9', '1.0.0-beta', '01.0.1', 'junk']) expect(newerVersion(v, '1.0.0')).toBe(false);
});
it('only accepts the canonical app identity, exact trusted path and bounded digest-bearing release', () => {
  expect(releaseFile(manifest, 'windows')).toEqual(file);
  for (const patch of [{ url: 'https://example.com/install.exe' }, { url: file.url + '?redirect=evil' }, { appId: 'other.app' }, { sha256: 'invalid' }, { size: 1024 * 1024 * 400 }, { version: '0.1.0' }]) expect(() => releaseFile({ ...manifest, windows: { ...file, ...patch } }, 'windows')).toThrow();
});
