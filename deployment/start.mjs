import path from 'node:path';
import { pathToFileURL } from 'node:url';
// Runtime provisioning is a build/deployment preparation step. Startup never
// downloads Node, dependencies, fonts or binaries, including after a restart.
const [major, minor, patch] = process.versions.node.split('.').map(Number);
if (major !== 24 || minor < 22 || (minor === 22 && patch < 1)) throw new Error('Preinstall patched Node 24.22.1 or newer within Node 24 before starting Dorham. See docs/DOMESTIC.md.');
await import(pathToFileURL(path.resolve('apps/api/dist/index.js')).href);
