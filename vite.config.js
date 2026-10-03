import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Two pages: the game, and the lab for testing and tuning movement.
export default defineConfig({
  // Relative asset paths, so the build runs from any folder: a GitHub Pages
  // project site (/rigor/), itch.io, or a plain file server.
  base: './',
  // Headless tests of the game's own systems (npm test).
  test: {
    include: ['tests/**/*.test.js'],
    setupFiles: ['tests/setup.js'],
    testTimeout: 30000,
  },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        lab: fileURLToPath(new URL('./lab.html', import.meta.url)),
      },
    },
  },
});
