import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
export default defineConfig({ define: { __APP_VERSION__: JSON.stringify(version) }, test: { include: ['tests/**/*.test.ts'], testTimeout: 30000, hookTimeout: 30000, fileParallelism: false } });
