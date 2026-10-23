import { defineConfig } from '@playwright/test';
const port = process.env.CLOSER_TEST_PORT || '3000';
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: './test',
  testMatch: '**/*.spec.js',
  timeout: 45000,
  workers: 1,
  use: {
    baseURL,
    viewport: { width: 390, height: 844 },
    launchOptions: { executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
    trace: 'retain-on-failure'
  },
  webServer: { command: 'npm start', url: `${baseURL}/api/health`, env: { PORT: port, HOST: '127.0.0.1' }, reuseExistingServer: false, timeout: 15000 }
});
