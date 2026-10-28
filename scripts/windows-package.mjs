import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
if (process.platform !== 'win32') throw new Error('Build the Windows installer on Windows.');
const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: process.env.CSC_IDENTITY_AUTO_DISCOVERY || 'false' };
const args = ['node_modules/electron-builder/cli.js', '--config', 'apps/desktop/electron-builder.yml', '--win', 'nsis', '--x64'];
if (existsSync('.tools/electron/electron.exe')) args.push(`--config.electronDist=${path.resolve('.tools/electron')}`);
if (existsSync('.tools/nsis/nsis-bundle/makensis.cmd')) {
  env.ELECTRON_BUILDER_NSIS_DIR = path.resolve('.tools/nsis/nsis-bundle');
  env.ELECTRON_BUILDER_NSIS_RESOURCES_DIR = env.ELECTRON_BUILDER_NSIS_DIR;
}
const result = spawnSync(process.execPath, args, { env, stdio: 'inherit', windowsHide: true });
process.exit(result.status ?? 1);
