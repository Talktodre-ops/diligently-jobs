import { defineConfig, devices } from '@playwright/test'

// Runs in the e2e container (network_mode: host), so the browser reaches the
// web app exactly as you do: http://localhost:<WEB_PORT>. Every project uses
// Microsoft Edge; the viewports are the four from the testing guide.
const baseURL = process.env.BASE_URL ?? `http://localhost:${process.env.WEB_PORT ?? 5190}`
const slowMo = process.env.PW_SLOWMO ? Number(process.env.PW_SLOWMO) : 0
const edge = { channel: 'msedge' as const, launchOptions: { slowMo } }

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'mobile', use: { ...devices['Desktop Edge'], ...edge, viewport: { width: 390, height: 844 }, isMobile: false, hasTouch: true } },
    { name: 'tablet', use: { ...devices['Desktop Edge'], ...edge, viewport: { width: 834, height: 1150 } } },
    { name: 'desktop', use: { ...devices['Desktop Edge'], ...edge, viewport: { width: 1440, height: 900 } } },
    { name: 'wide', use: { ...devices['Desktop Edge'], ...edge, viewport: { width: 1920, height: 1080 } } },
  ],
})
