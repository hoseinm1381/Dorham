export const RELEASE_ORIGIN = 'https://dorhamapp.ir';
export const APP_ID = 'com.dorham.chat';
export type ReleasePlatform = 'windows' | 'android';
export type ReleaseFile = { version: string; url: string; sha256: string; size: number; appId: string; versionCode?: number };
export type ReleaseManifest = { schema: 1; version: string; publishedAt: string; windows: ReleaseFile; android: ReleaseFile; androidArm64?: ReleaseFile };
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function validReleaseVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 50 && versionPattern.test(value) && value.split('.').every(part => Number.isSafeInteger(Number(part)));
}
export function newerVersion(candidate: string, current: string): boolean {
  if (!validReleaseVersion(candidate) || !validReleaseVersion(current)) return false;
  const a = candidate.split('.').map(Number), b = current.split('.').map(Number);
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

export function releaseDownloads(value: unknown): Pick<ReleaseManifest, 'windows' | 'android' | 'androidArm64'> {
  const catalog = value as { schema?: number; windows?: unknown; android?: unknown };
  const windows = releaseFile(catalog?.schema === 2 ? catalog.windows : value, 'windows');
  const androidManifest = (catalog?.schema === 2 ? catalog.android : value) as ReleaseManifest;
  const android = releaseFile(androidManifest, 'android');
  const variant = androidManifest.androidArm64;
  const androidArm64 = variant && variant.version === android.version && variant.appId === android.appId &&
    variant.versionCode === android.versionCode && /^[a-f0-9]{64}$/.test(variant.sha256) &&
    Number.isSafeInteger(variant.size) && variant.size >= 1024 && variant.size <= android.size &&
    variant.url === `${RELEASE_ORIGIN}/downloads/${android.version}/Dorham-${android.version}-Android-arm64-v8a.apk` ? variant : undefined;
  return { windows, android, ...(androidArm64 ? { androidArm64 } : {}) };
}
