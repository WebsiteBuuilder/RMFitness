import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// GitHub Pages serves a project site under /<repo>/, so the base is set by
// the deploy workflow; local dev and previews use "/".
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  plugins: [preact()],
  build: { target: 'es2020' },
});
