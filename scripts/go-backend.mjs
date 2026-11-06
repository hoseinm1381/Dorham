import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd(), moduleDir = path.join(root, 'apps/api-go');
const action = process.argv[2] || 'build', args = process.argv.slice(3);
const localGo = path.join(root, '.tools/go-toolchain/go/bin', process.platform === 'win32' ? 'go.exe' : 'go');
const compiler = process.env.DORHAM_GO || (existsSync(localGo) ? localGo : 'go');
const run = (command, argv, options = {}) => {
  const result = spawnSync(command, argv, { cwd: root, stdio: 'inherit', windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};
const env = {
  ...process.env, GOTOOLCHAIN: 'local', CGO_ENABLED: '0',
  GOMODCACHE: process.env.GOMODCACHE || path.join(root, '.tools/go-modules'),
  GOCACHE: process.env.GOCACHE || path.join(root, '.tools/go-build-cache'),
  GOPATH: process.env.GOPATH || path.join(root, '.tools/go-path'),
};
if (action === 'build' || action === 'test') {
  if (action === 'test') run(compiler, ['test', '-mod=readonly', './...', ...args], { cwd: moduleDir, env });
  else {
    const linux = args.includes('--linux');
    if (args.some(value => value !== '--linux')) throw Error('Supported build option: --linux');
    const os = linux ? 'linux' : process.platform === 'win32' ? 'windows' : process.platform;
    const output = path.join(moduleDir, 'dist', `dorham${os === 'windows' ? '.exe' : ''}`);
    mkdirSync(path.dirname(output), { recursive: true });
    const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    run(compiler, ['build', '-mod=readonly', '-buildvcs=false', '-trimpath', `-ldflags=-s -w -X dorham.local/backend/internal/backend.Version=${version}`, '-o', output, './cmd/dorham'], {
      cwd: moduleDir, env: { ...env, GOOS: os, GOARCH: 'amd64' },
    });
    console.log(`Built Go backend: ${output}`);
  }
} else if (action === 'start' || action === 'backup') {
  const binary = path.join(moduleDir, 'dist', `dorham${process.platform === 'win32' ? '.exe' : ''}`);
  if (!existsSync(binary)) throw Error('Run npm run build:api:go first. Production systemd should execute the binary directly.');
  run(binary, action === 'backup' ? ['backup', ...args] : args);
} else throw Error('Expected build, test, start or backup');
