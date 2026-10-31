# DorHam (دور هم) icons · Soft Bubble

123 interface icons, 60 filled/active variants and 64 emoji, including 9 DorHam-only reactions. Everything
is hand-built, editable SVG: no raster images and no filters.

Open **`index.html`** to browse. It's searchable, has light/dark themes, and lets you copy SVG or a sprite snippet.

## Folder structure

```
dorham-icons/
├── index.html              searchable gallery + visual style guide
├── interface/              24×24, currentColor
│   ├── navigation/  messaging/  voice-video/  servers/  social/  media/
├── emojis/                 64×64, full color
│   ├── expressions/  reactions/  gaming/  dorham-exclusive/
├── variants/filled/        active-state icons  (<name>-filled.svg)
├── sprite/                 dorham-interface.svg (outline + filled), dorham-emoji.svg
├── manifest/               icons.json, icons.ts (typed names + metadata)
├── previews/               preview sheets: interface / filled / emoji × light / dark
├── style-guide/            README.md, tokens.css, tokens.json
└── src/                    generator (python src/build.py rebuilds everything)
```

## Using the icons

**Inline / React**: interface icons inherit text color.
```html
<span class="dh-icon" style="color: var(--dh-coral)"><!-- paste interface/messaging/message.svg --></span>
```

**Sprite**
```html
<svg class="dh-icon"><use href="/sprite/dorham-interface.svg#dh-microphone-muted"/></svg>
<svg class="dh-icon dh-icon--active"><use href="/sprite/dorham-interface.svg#dh-home-filled"/></svg>
<svg class="dh-emoji"><use href="/sprite/dorham-emoji.svg#dh-dorham-tea-time"/></svg>
```
External `<use>` references need the sprite served from the same origin.

**Types**
```ts
import { dorhamIcons, type DorHamIconName, spriteId } from "./manifest/icons";
```

## The DorHam exclusives

| File | Meaning |
|---|---|
| `dorham-hangout` | Three friends squished on the couch: just hanging out |
| `dorham-friend-joined` | Star-eyed hype with a "+1" badge: they're here! |
| `dorham-awkward-silence` | Side-eye, flat mouth, sweat drop and an empty "…" bubble in voice |
| `dorham-dying-laughing` | Tipped over, can't breathe, tears flying |
| `dorham-teasing` | Smug smirk, tongue out and a cheeky poke |
| `dorham-late-night` | Headset on, eye bags, screen glow, moon out: one more game |
| `dorham-group-celebration` | Three faces in party hats with confetti |
| `dorham-group-hug` | Two friends, cheek to cheek, arms around each other |
| `dorham-tea-time` | Chai in an estekan, eyes closed: the most دور هم moment |

## Editing

The SVGs are generated from `src/interface.py` and `src/emoji.py`. You can edit the files directly, or change
the source and run `python src/build.py` (Python 3.9+, no dependencies). The build rebuilds every export
and checks that all SVGs are valid XML with no duplicate ids. See `style-guide/README.md` for the rules.
