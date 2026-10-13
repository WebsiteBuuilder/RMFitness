import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import preact from '@preact/preset-vite';

/** Changes with every build: card data asks for ?v=<this>, and the service worker's caches carry it. */
const BUILD_ID = Date.now().toString(36);

/**
 * The installed app's service worker (pwa/sw.js), written next to index.html at build
 * time with this build's id and its list of app files filled in.
 */
function pwa(): Plugin {
  return {
    name: 'eds-pwa',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const files = Object.keys(bundle).filter((f) => f.startsWith('assets/') && /\.(js|css)$/.test(f));
      const shell = ['./', ...files, 'manifest.webmanifest', 'favicon.ico', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/icon.svg'];
      const source = readFileSync(new URL('./pwa/sw.js', import.meta.url), 'utf8').replace('__BUILD_ID__', BUILD_ID).replace("'__SHELL__'", JSON.stringify(JSON.stringify(shell)));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

// GitHub Pages serves a project site under /<repo>/, so the base is set by
// the deploy workflow; local dev and previews use "/".
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  plugins: [preact(), pwa()],
  build: { target: 'es2020' },
  // Stamped into the app so each deploy asks for fresh card data.
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
});
