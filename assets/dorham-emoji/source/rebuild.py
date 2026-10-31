from pathlib import Path
from emoji import EMOJI, svg
root = Path(__file__).resolve().parents[1]
for e in EMOJI:
    path = root / 'emojis' / e.cat / (e.name + '.svg')
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(svg(e.body) + '\n', encoding='utf-8')
print(f'Rebuilt {len(EMOJI)} editable emoji SVGs.')
