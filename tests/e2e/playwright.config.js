import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.js',
  outputDir: 'results',
  timeout: 60000,
  reporter: [['list']],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://web',
    viewport: { width: 1400, height: 900 },
    trace: 'retain-on-failure',
  },
});
