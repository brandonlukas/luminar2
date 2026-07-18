import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths so the build works at any URL,
  // including GitHub Pages' /<repo>/ subpath.
  base: './',
  build: {
    rollupOptions: {
      input: ['./index.html', './studio.html'],
    },
  },
});
