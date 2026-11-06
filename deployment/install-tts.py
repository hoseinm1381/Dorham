"""Install optional local bilingual speech. Run explicitly with operator privileges, never at app startup."""
from pathlib import Path
import hashlib,json,os,subprocess,urllib.request,venv
source=Path(__file__).resolve().parent
root=Path(os.environ.get('DORHAM_TTS_ROOT','/opt/dorham-tts'));root.mkdir(parents=True,exist_ok=True)
def fetch(url):
    with urllib.request.urlopen(url,timeout=120) as response:return response.read()
def download(url,target,digest):
    if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest()==digest:return
    data=fetch(url)
    if hashlib.sha256(data).hexdigest()!=digest:raise RuntimeError('Download digest mismatch')
    target.write_bytes(data)
environment=root/'venv'
if not (environment/'bin/python').exists():venv.EnvBuilder(with_pip=False).create(environment)
python=str(environment/'bin/python')
metadata=json.loads(fetch('https://pypi.org/pypi/pip/26.2/json'))
wheel=next(item for item in metadata['urls'] if item['filename'].endswith('.whl'));target=root/wheel['filename']
download(wheel['url'],target,wheel['digests']['sha256'])
subprocess.run([python,'-m','pip','install',str(target)],env={**os.environ,'PYTHONPATH':str(target)},check=True)
subprocess.run([python,'-m','pip','install','-r',str(source/'tts-requirements.txt')],check=True)
voices=root/'voices';voices.mkdir(exist_ok=True)
manifest=json.loads((source/'tts-models.json').read_text())
for name,entry in manifest['voices'].items():
    if Path(name).name!=name:raise RuntimeError('Invalid model filename')
    download(entry['url'],voices/name,entry['sha256'])
(root/'manifest.json').write_text(json.dumps(manifest,indent=2))
subprocess.run([python,str(source/'optimize-tts.py'),'--models',str(voices)],check=True)
print('Local speech runtime and both pinned voice models verified. No application service was restarted.')
