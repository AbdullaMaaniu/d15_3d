import { defineConfig } from '@playwright/test';

// Uses a system Chromium when CHROMIUM_PATH is set (e.g. in sandboxes without Playwright's download).
const executablePath = process.env.CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: 'e2e',
  timeout: 180_000,
  expect: { timeout: 60_000 },
  use: {
    baseURL: 'http://localhost:5173',
    viewport: { width: 1440, height: 900 },
    launchOptions: {
      executablePath,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    },
  },
  webServer: {
    command: 'pnpm --filter @rigforge/editor exec vite --port 5173 --strictPort',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
