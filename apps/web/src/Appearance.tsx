import { useState } from 'react';
import { Check } from 'lucide-react';
import { t } from './i18n';
import './appearance.css';

const palettes = { default: 'Dorham', ocean: 'Ocean', forest: 'Forest', ember: 'Ember', dusk: 'Dusk' } as const;
type Palette = keyof typeof palettes;
const key = 'dorham.palette';

function storedPalette(): Palette {
  try {
    const value = localStorage.getItem(key);
    if (value && Object.hasOwn(palettes, value)) return value as Palette;
  } catch { /* Storage can be unavailable in private sessions. */ }
  return 'default';
}

export function initializeAppearance() { document.documentElement.dataset.palette = storedPalette(); }

export function AppearanceSettings() {
  const [active, setActive] = useState(storedPalette);
  return <fieldset className="app-palettes">
    <legend>{t('Color palette')}</legend>
    <div className="palette-grid">
      {(Object.keys(palettes) as Palette[]).map(id => <label key={id} className="palette-choice">
        <input type="radio" name="color-palette" checked={active === id} onChange={() => {
          setActive(id);
          document.documentElement.dataset.palette = id;
          try { localStorage.setItem(key, id); } catch { /* The palette still applies for this session. */ }
        }}/>
        <span className="palette-preview" data-swatch={id} aria-hidden="true">
          <span className="palette-preview-rail"><i/><i/></span>
          <span className="palette-preview-sidebar"><i/><i/><i/></span>
          <span className="palette-preview-chat">
            <i className="palette-preview-heading"/><i className="palette-preview-message"/>
            <i className="palette-preview-message"/><i className="palette-preview-composer"/>
          </span>
        </span>
        <span className="palette-name">{t(palettes[id])}<span className="palette-selected" aria-hidden="true"><Check size={13}/></span></span>
      </label>)}
    </div>
  </fieldset>;
}
