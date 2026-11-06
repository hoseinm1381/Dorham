import { useEffect, useState } from 'react';
import { assetUrl, request } from './api';

export function InviteBranding() {
  const code = new URLSearchParams(location.search).get('invite');
  const [branding, setBranding] = useState<{ name: string; banner?: string; blurb?: string }>();
  useEffect(() => {
    if (!code || code.length < 10 || code.length > 100) return;
    const controller = new AbortController();
    void request<typeof branding>(`/features/invite?code=${encodeURIComponent(code)}`, undefined, 'GET', false, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) setBranding(value);
    }).catch(() => {});
    return () => controller.abort();
  }, [code]);
  if (!branding?.banner && !branding?.blurb) return null;
  return <section className="feature-announcement" dir="auto">
    {branding.banner && <img className="profile-banner-image" src={assetUrl(branding.banner)} alt=""/>}
    <strong>{branding.name}</strong>{branding.blurb && <p>{branding.blurb}</p>}
  </section>;
}
