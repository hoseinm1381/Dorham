import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { readFileSync } from 'node:fs';
const version = process.env.DORHAM_WINDOWS_VERSION ?? JSON.parse(readFileSync('package.json', 'utf8')).version;
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('Invalid Dorham client version');
const desktopEntry = {
  name: 'dorham-tauri-entry',
  transformIndexHtml: { order: 'pre' as const, handler: (html: string) => html.replace('/src/main.tsx', '/src/tauri-entry.ts') },
};
export default defineConfig({ define: { __APP_VERSION__: JSON.stringify(version) }, root: path.resolve('apps/web'), plugins: [react(), ...(process.env.DORHAM_WINDOWS_VERSION ? [desktopEntry] : [])], base: './', server: { host: '127.0.0.1', port: 5173, proxy: { '/api': 'http://127.0.0.1:3001', '/avatars': 'http://127.0.0.1:3001', '/catalog': 'http://127.0.0.1:3001', '/socket.io': { target: 'http://127.0.0.1:3001', ws: true } } }, build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 900 } });
