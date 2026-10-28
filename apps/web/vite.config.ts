import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
export default defineConfig({ root: path.resolve('apps/web'), plugins: [react()], base: './', server: { host: '127.0.0.1', port: 5173, proxy: { '/api': 'http://127.0.0.1:3001', '/avatars': 'http://127.0.0.1:3001', '/socket.io': { target: 'http://127.0.0.1:3001', ws: true } } }, build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 900 } });
