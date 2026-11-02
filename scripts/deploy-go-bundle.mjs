import { cp, mkdir, readFile, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd(), source = JSON.parse(await readFile('package.json', 'utf8'));
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true });
if (revision.status !== 0) throw Error('Cannot record source revision');
const sourceCommit = revision.stdout.trim();
if (!/^\d+\.\d+\.\d+$/.test(source.version)) throw Error('Use a numeric release version.');
const output = path.resolve(`artifacts/server-${source.version}-go`);
if (path.dirname(output) !== path.join(root, 'artifacts')) throw Error('Invalid generated output path');
// This exact versioned directory contains only generated deployment output.
// Rebuild from empty staging so removed documentation/scripts cannot linger.
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const binary = await readFile('apps/api-go/dist/dorham');
if (!binary.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) throw Error('Build the Linux backend with npm run build:api:go -- --linux first.');
if (binary[4] !== 2 || binary[5] !== 1 || binary.readUInt16LE(18) !== 62) throw Error('Expected a Linux x86-64 ELF executable.');
await mkdir(path.join(output, 'apps/api-go/dist'), { recursive: true });
await cp('apps/api-go/dist/dorham', path.join(output, 'apps/api-go/dist/dorham'));
for (const entry of ['apps/web/dist', 'docs', 'deployment', '.env.example', '.dockerignore']) await cp(entry, path.join(output, entry), { recursive: true });
await writeFile(path.join(output, 'package.json'), JSON.stringify({ name: 'dorham-go-server', version: source.version, private: true, scripts: { start: './apps/api-go/dist/dorham' } }, null, 2));
await writeFile(path.join(output, 'README.txt'), 'Dorham Go server for Linux x86-64.\nRun ./apps/api-go/dist/dorham directly; Node and a Go compiler are not required.\nConfigure the existing environment and persistent DATA_DIR first.\nPiper speech requires the separately installed Python environment and model files.\nSee docs/MIGRATION-1.1.0.md and docs/DEPLOYMENT.md.\nNo database, credentials, signing keys or native client installers are included.\n');
const files = {};
async function inventory(dir) {
  for (const name of (await readdir(dir)).sort()) {
    const target = path.join(dir, name), info = await stat(target);
    if (info.isDirectory()) await inventory(target);
    else files[path.relative(output, target).split(path.sep).join('/')] = createHash('sha256').update(await readFile(target)).digest('hex');
  }
}
await inventory(output);
await writeFile(path.join(output, 'GO_RELEASE.json'), JSON.stringify({ version: source.version, runtime: 'go', target: 'linux/amd64', cgo: false, sourceCommit, files }, null, 2));
const archive = path.resolve(`artifacts/Dorham-${source.version}-Go-Server.zip`);
const python = process.env.DORHAM_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const archiveCode = `import pathlib,sys,zipfile
root=pathlib.Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2],"w",zipfile.ZIP_DEFLATED) as out:
 for p in sorted(root.rglob("*")):
  if not p.is_file(): continue
  name=p.relative_to(root).as_posix()
  entry=zipfile.ZipInfo(name);entry.create_system=3;entry.compress_type=zipfile.ZIP_DEFLATED
  entry.external_attr=(0o100755 if name=="apps/api-go/dist/dorham" else 0o100644)<<16
  out.writestr(entry,p.read_bytes())
`;
const result = spawnSync(python, ['-c', archiveCode, output, archive], { stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`Go deployment package: ${archive}`);
