import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { appCacheManifest } from './app-cache-manifest.ts';

const appCache = (): Plugin => ({
  name: 'app-cache', apply: 'build', enforce: 'post',
  generateBundle(_options, bundle) {
    const html = bundle['index.html'];
    const manifest = appCacheManifest(Object.keys(bundle), process.env.SHIELDED_APP_CACHE_FORCE === '1', html?.type === 'asset' ? html.source : '');
    this.emitFile({ type: 'asset', fileName: 'sw.js', source: readFileSync(new URL('./sw.js', import.meta.url), 'utf8').replace('__APP_CACHE__', () => JSON.stringify(manifest)) });
  },
});

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), appCache()],
  resolve: {alias: {circomlibjs:fileURLToPath(new URL('./src/circom-browser.ts',import.meta.url))}},
  server: { host: '0.0.0.0', port: 5173, proxy: { '/api': process.env.SHIELDED_API_ORIGIN??'http://127.0.0.1:8792' } },
  build: { outDir: 'dist', emptyOutDir: true },
});
