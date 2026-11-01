"""Explicit asset preparation only. Run with a prepared Piper Python environment.

Set DORHAM_TTS_MODELS to the verified voices folder. Normal app builds do not run
this script, download models, install Python dependencies or generate speech.
"""
from pathlib import Path
import hashlib, io, json, wave

root = Path(__file__).resolve().parents[1]
directory = root / 'assets/tts-loading'
manifest = json.loads((directory / 'manifest.json').read_text(encoding='utf-8'))
namespace = {'__name__': 'dorham_static_recording'}
source = (root / 'deployment/tts-worker.py').read_text(encoding='utf-8').split('\nfor line in sys.stdin:')[0]
exec(compile(source, '<dorham-tts-asset-generator>', 'exec'), namespace)
for clip in manifest['clips']:
    data = namespace['synthesize'](clip['text'])
    with wave.open(io.BytesIO(data)) as audio:
        assert audio.getnchannels() == 1 and audio.getsampwidth() == 2 and audio.getframerate() == 22050
        clip['seconds'] = round(audio.getnframes()/audio.getframerate(), 3)
    (directory / clip['file']).write_bytes(data)
    clip.update(sha256=hashlib.sha256(data).hexdigest(), bytes=len(data))
(directory / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print('Regenerated local loading recordings. Review both clips before rebuilding.')
