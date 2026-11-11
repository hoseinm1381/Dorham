import registry from '../../../apps/api-go/internal/backend/client_features.json';
import { newerVersion, validReleaseVersion } from './releases';

export type ClientFeature = {
  id: string;
  minVersion: string;
  name: { en: string; fa: string };
  gameKinds?: string[];
};

export const clientFeatures: readonly ClientFeature[] = registry;
export const gameClientFeatures = clientFeatures.filter(feature => feature.gameKinds?.length);

export function supportsClientFeature(feature: ClientFeature, version: unknown) {
  return validReleaseVersion(feature.minVersion) && validReleaseVersion(version) && !newerVersion(feature.minVersion, version);
}

export function gameClientFeature(kind: string) {
  return gameClientFeatures.find(feature => feature.gameKinds?.includes(kind));
}

export function legacyFeatureNotices(platform: unknown, version: unknown) {
  if (!validReleaseVersion(version) || !['web', 'windows', 'android'].includes(String(platform))) return [];
  return clientFeatures.filter(feature => !supportsClientFeature(feature, version)).map(feature => ({
    id: `client-update:${feature.id}`,
    en: platform === 'web'
      ? `Refresh Dorham to use ${feature.name.en}. Version ${feature.minVersion} or later is required.`
      : `Update Dorham to ${feature.minVersion} or later to use ${feature.name.en}. Open Get apps to check for updates.`,
    fa: platform === 'web'
      ? `برای استفاده از ${feature.name.fa}، دورهم را دوباره بارگیری کنید. نسخهٔ ${feature.minVersion} یا بالاتر لازم است.`
      : `برای استفاده از ${feature.name.fa}، دورهم را به نسخهٔ ${feature.minVersion} یا بالاتر به‌روزرسانی کنید. از بخش دریافت برنامه‌ها به‌روزرسانی‌ها را بررسی کنید.`,
  }));
}
