import { defineConfig, devices } from '@playwright/test';

// Smoke tests of the built game in a real browser (npm run test:e2e): it
// loads, starts, moves, and nothing throws. Runs against `vite preview` of
// the production build, the same files that go to GitHub Pages.
export default defineConfig({
  testDir: 'e2e',
  timeout: 60000,
  // One browser at a time: software WebGL is all CPU, and two at once starve each other.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    viewport: { width: 1280, height: 720 },
    // Software WebGL, so it runs on machines without a GPU (CI).
    launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npx vite build && npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
