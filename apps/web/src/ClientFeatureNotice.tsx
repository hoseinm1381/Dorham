import type { ClientFeature } from '../../../packages/contracts/src/client-features';
import { releasePlatform } from './ReleaseProvider';
import { currentLanguage, t } from './i18n';

export function ClientFeatureNotice({ feature }: { feature: ClientFeature }) {
  const name = feature.name[currentLanguage() === 'fa-IR' ? 'fa' : 'en'];
  return <p className="feature-announcement client-feature-update" role="status" data-feature={feature.id}>
    {t('Dorham {version} or later is required to use {feature}.', { version: feature.minVersion, feature: name })}
    {' '}
    {releasePlatform ? t('Open Get apps to check for updates.') : <button type="button" className="secondary" onClick={() => location.reload()}>{t('Reload Dorham')}</button>}
  </p>;
}
