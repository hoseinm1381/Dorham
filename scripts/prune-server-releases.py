"""Prune obsolete Dorham binaries after publishing valid current manifests.

Run on the existing Linux server. Default is a preview; --apply removes only
obsolete versioned downloads, old deployment copies and release staging files.
The running application, database, uploads, models and private backups stay put.
"""
from pathlib import Path
import argparse
import hashlib
import json
import re
import shutil
import subprocess
from urllib.parse import urlparse

parser = argparse.ArgumentParser()
parser.add_argument('--apply', action='store_true')
args = parser.parse_args()
downloads = Path('/var/lib/dorham-downloads')
runtime = Path('/opt/dorham')
assert downloads.resolve() == downloads and runtime.resolve() == runtime
version = re.compile(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)')

def digest(p):
    with p.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()

def services():
    return {n: subprocess.check_output(['systemctl', 'show', n, '-p', 'MainPID', '-p', 'ExecMainStartTimestampMonotonic'], text=True) for n in ['dorham', 'livekit', 'caddy', 'haproxy']}

def files(directory):
    return {str(p.relative_to(directory)): digest(p) for p in directory.rglob('*') if p.is_file()}

keep = set()
metadata = {}
def validate(manifest):
    if manifest.get('schema') == 2:
        for platform in ['windows', 'android']:
            validate(manifest[platform])
        return
    assert manifest['schema'] == 1 and version.fullmatch(manifest['version'])
    for platform in ['windows', 'android']:
        if platform not in manifest:
            continue
        entry = manifest[platform]
        v = entry['version']
        assert v == manifest['version'] and entry['appId'] == 'com.dorham.chat'
        suffix = 'Windows-x64.exe' if platform == 'windows' else 'Android.apk'
        expected = f'https://dorhamapp.ir/downloads/{v}/Dorham-{v}-{suffix}'
        assert entry['url'] == expected
        p = downloads / v / Path(urlparse(expected).path).name
        assert p.is_file() and not p.is_symlink() and p.resolve().is_relative_to(downloads)
        assert p.stat().st_size == entry['size'] and digest(p) == entry['sha256']
        keep.add(v)

for name in ['latest.json', 'windows.json', 'android.json', 'releases.json']:
    p = downloads / name
    metadata[name] = digest(p)
    validate(json.loads(p.read_text()))
assert keep

targets = [p for p in downloads.iterdir() if p.is_dir() and version.fullmatch(p.name) and p.name not in keep]
old = [p for p in Path('/opt').iterdir() if p.is_dir() and p.name.startswith('dorham-before-') and version.fullmatch(p.name.removeprefix('dorham-before-'))]
old.sort(key=lambda p: tuple(map(int, p.name.removeprefix('dorham-before-').split('.'))))
# Keep the most recent full server rollback, alongside all private data backups.
targets.extend(old[:-1])
staging = re.compile(r'dorham-(?:\d+\.\d+\.\d+|web-|v\d+).+\.(?:zip|exe|apk)')
targets.extend(p for p in Path('/tmp').iterdir() if p.is_file() and staging.fullmatch(p.name))
for p in targets:
    assert not p.is_symlink() and p.resolve() == p and p.parent in [downloads, Path('/opt'), Path('/tmp')]
    assert p != runtime
    # Never remove a path referenced by a running systemd service.
    for n in ['dorham', 'livekit', 'caddy', 'haproxy']:
        unit = subprocess.check_output(['systemctl', 'show', n, '-p', 'ExecStart', '-p', 'WorkingDirectory'], text=True)
        assert str(p) not in unit

before_services = services()
before_web = files(runtime / 'apps/web/dist')
before_runtime = digest(runtime / 'package.json')
before_config = digest(Path('/etc/caddy/Caddyfile'))
before_free = shutil.disk_usage('/').free
removed = []
for p in targets:
    if args.apply:
        if p.is_dir():
            shutil.rmtree(p)
        else:
            p.unlink()
    removed.append(str(p))
assert services() == before_services
assert files(runtime / 'apps/web/dist') == before_web
assert digest(runtime / 'package.json') == before_runtime
assert digest(Path('/etc/caddy/Caddyfile')) == before_config
assert all(digest(downloads / name) == value for name, value in metadata.items())
print(json.dumps({'applied': args.apply, 'retainedPublicVersions': sorted(keep), 'retainedServerRollback': str(old[-1]) if old else None, 'removed' if args.apply else 'candidates': removed, 'bytesFreed': max(0, shutil.disk_usage('/').free - before_free) if args.apply else 0, 'currentWebAndServicesUnchanged': True, 'databaseUploadsAndPrivateBackupsUntouched': True}, indent=2))
