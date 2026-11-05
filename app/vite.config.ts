import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { appCacheManifest } from './app-cache-manifest.ts';

const force = process.env.SHIELDED_APP_CACHE_FORCE === '1', off = process.env.SHIELDED_APP_CACHE_OFF === '1';

const appCache = (): Plugin => ({
  name: 'app-cache', apply: 'build', enforce: 'post',
  generateBundle(_options, bundle) {
    if (off || force) this.warn(off ? 'SHIELDED_APP_CACHE_OFF=1: sw.js removes the app cache and the page no longer registers one' : 'SHIELDED_APP_CACHE_FORCE=1: sw.js takes over on install, without waiting for Update');
    const html = bundle['index.html'];
    if (html?.type !== 'asset') this.error('app/sw.js: index.html is missing from the Vite bundle; the app cache cannot be built');
    const manifest = appCacheManifest(Object.keys(bundle), force, html.source);
    this.emitFile({ type: 'asset', fileName: 'sw.js', source: readFileSync(new URL(off ? './sw-off.js' : './sw.js', import.meta.url), 'utf8').replace('__APP_CACHE__', () => JSON.stringify(manifest)) });
  },
});

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  define: { __APP_CACHE_OFF__: JSON.stringify(off) },
  plugins: [react(), appCache()],
  resolve: {alias: {circomlibjs:fileURLToPath(new URL('./src/circom-browser.ts',import.meta.url))}},
  server: { host: '0.0.0.0', port: 5173, proxy: { '/api': process.env.SHIELDED_API_ORIGIN??'http://127.0.0.1:8792' } },
  build: { outDir: 'dist', emptyOutDir: true },
});
