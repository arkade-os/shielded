import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  server: { host: '0.0.0.0', port: 5173, proxy: { '/api': 'http://127.0.0.1:8787' } },
  build: { outDir: 'dist', emptyOutDir: true },
});
