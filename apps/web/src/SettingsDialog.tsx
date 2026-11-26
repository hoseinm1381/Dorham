import { ArrowLeft, ChevronRight, X, type LucideIcon } from 'lucide-react';
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { t } from './i18n';
import './settings-dialog.css';

export type SettingsGroup<Id extends string> = {
  label: string;
  sections: { id: Id; label: string; icon: LucideIcon }[];
};

export function SettingsDialog<Id extends string>({
  title, groups, initial, close, children, footer, notice,
}: {
  title: string;
  groups: SettingsGroup<Id>[];
  initial?: Id;
  close: () => void;
  children: (section: Id) => ReactNode;
  footer?: ReactNode;
  notice?: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const header = useRef<HTMLHeadingElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const navigation = useRef<HTMLElement>(null);
  const idPrefix = useId();
  const [selected, setSelected] = useState(initial);
  const sections = groups.flatMap(group => group.sections);
  const active = sections.find(section => section.id === selected) ?? sections[0];
  const showingSection = selected === active.id;
  const mobile = () => matchMedia('(max-width: 680px)').matches;

  useLayoutEffect(() => {
    const node = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    node.showModal();
    header.current?.focus();
    return () => { node.close(); if (previous?.isConnected) previous.focus(); };
  }, []);

  useLayoutEffect(() => {
    if (content.current) content.current.scrollTop = 0;
  }, [active.id]);

  function back() {
    setSelected(undefined);
    requestAnimationFrame(() => navigation.current?.querySelector<HTMLButtonElement>(`[data-section="${active.id}"]`)?.focus());
  }

  useLayoutEffect(() => {
    function handleBack(event: Event) {
      if (event.defaultPrevented || !mobile() || !showingSection) return;
      event.preventDefault();
      back();
    }
    window.addEventListener('dorham-back', handleBack, true);
    return () => window.removeEventListener('dorham-back', handleBack, true);
  }, [showingSection, active.id]);

  return <dialog ref={dialog} aria-label={title} className="modal-backdrop settings-backdrop"
    onCancel={event => { event.preventDefault(); if (mobile() && showingSection) back(); else close(); }}
    onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="modal settings-dialog" data-show-section={showingSection}>
      <header className="settings-header">
        {showingSection && <button type="button" className="icon-button settings-back" onClick={back} aria-label={t('Back to settings')}><ArrowLeft size={20}/></button>}
        <h2 ref={header} tabIndex={-1}>{title}</h2>
        <button type="button" className="icon-button" onClick={close} aria-label={t('Close dialog')} title={t('Close dialog')}><X size={21}/></button>
      </header>
      <div className="settings-layout">
        <nav ref={navigation} className="settings-navigation" aria-label={t('Settings sections')}>
          <div role="tablist" aria-label={t('Settings sections')} aria-orientation="vertical" onKeyDown={event => {
            if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
            const index = sections.findIndex(section => section.id === (event.target as HTMLElement).dataset.section);
            if (index < 0) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1 :
              (index + (event.key === 'ArrowUp' ? -1 : 1) + sections.length) % sections.length;
            if (!mobile()) setSelected(sections[next].id);
            navigation.current?.querySelector<HTMLButtonElement>(`[data-section="${sections[next].id}"]`)?.focus();
          }}>
          {groups.map(group => <div className="settings-group" key={group.label}>
            <h3>{t(group.label)}</h3>
            {group.sections.map(({ id, label, icon: Icon }) => <button key={id} type="button" data-section={id} role="tab"
              id={`${idPrefix}-${id}`} aria-controls={`${idPrefix}-panel`} aria-selected={active.id === id} tabIndex={active.id === id ? 0 : -1}
              onClick={() => {
                setSelected(id);
                if (mobile()) requestAnimationFrame(() => content.current?.querySelector<HTMLElement>('h3')?.focus());
              }}>
              <Icon size={17} aria-hidden="true"/><span>{t(label)}</span>
              <ChevronRight size={16} className="settings-chevron" aria-hidden="true"/>
            </button>)}
          </div>)}
          </div>
          {footer && <div className="settings-footer">{footer}</div>}
        </nav>
        <div className="settings-content" ref={content}>
          <section className="settings-page" role="tabpanel" id={`${idPrefix}-panel`} aria-labelledby={`${idPrefix}-${active.id}`}>
            <h3 className="settings-section-title" tabIndex={-1}>{t(active.label)}</h3>
            {children(active.id)}
          </section>
        </div>
      </div>
      {notice}
    </div>
  </dialog>;
}
