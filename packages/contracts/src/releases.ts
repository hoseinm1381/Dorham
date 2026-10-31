export const RELEASE_ORIGIN = 'https://dorhamapp.ir';
export const APP_ID = 'com.dorham.chat';
export type ReleasePlatform = 'windows' | 'android';
export type ReleaseFile = { version: string; url: string; sha256: string; size: number; appId: string; versionCode?: number };
export type ReleaseManifest = { schema: 1; version: string; publishedAt: string; windows: ReleaseFile; android: ReleaseFile };
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function newerVersion(candidate: string, current: string): boolean {
  if (!versionPattern.test(candidate) || !versionPattern.test(current)) return false;
  const a = candidate.split('.').map(Number), b = current.split('.').map(Number);
  if ([...a, ...b].some(n => !Number.isSafeInteger(n))) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
export function releaseFile(value: unknown, platform: ReleasePlatform): ReleaseFile {
  const manifest = value as ReleaseManifest;
  if (!manifest || manifest.schema !== 1 || !versionPattern.test(manifest.version)) throw Error('Invalid release manifest');
  const file = manifest[platform];
  if (!file || file.version !== manifest.version || file.appId !== APP_ID || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 1024 || file.size > 300 * 1048576) throw Error('Invalid release file');
  const extension = platform === 'windows' ? 'exe' : 'apk';
  const name = `Dorham-${file.version}-${platform === 'windows' ? 'Windows-x64' : 'Android'}.${extension}`;
  if (file.url !== `${RELEASE_ORIGIN}/downloads/${file.version}/${name}`) throw Error('Untrusted release address');
  if (platform === 'android' && (!Number.isSafeInteger(file.versionCode) || file.versionCode! < 1)) throw Error('Invalid Android build number');
  return file;
}
