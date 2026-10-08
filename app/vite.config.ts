import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  resolve: {alias: {circomlibjs:fileURLToPath(new URL('./src/circom-browser.ts',import.meta.url))}},
  server: { host: '0.0.0.0', port: 5173, proxy: { '/api': process.env.SHIELDED_API_ORIGIN??'http://127.0.0.1:8792' } },
  build: { outDir: 'dist', emptyOutDir: true },
});
