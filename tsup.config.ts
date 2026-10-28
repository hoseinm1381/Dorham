import { defineConfig } from 'tsup';
export default defineConfig({ entry: { index: 'apps/api/src/index.ts', database: 'scripts/database.ts' }, outDir: 'apps/api/dist', format: ['esm'], platform: 'node', target: 'node24', noExternal: [/^@dorham\//], clean: true, sourcemap: true });
