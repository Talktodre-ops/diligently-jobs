import { expect, test } from '@playwright/test'
import { createReadyAccount } from '../support/account'

test('a signed-out visitor lands on Welcome', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveURL(/\/welcome$/)
})

test('the API answers through the web origin', async ({ request }) => {
  const res = await request.get('/health')
  expect(res.ok()).toBe(true)
  expect((await res.json()).status).toBe('ok')
})

test('a ready account can be created through the real API and email outbox', async ({ baseURL }) => {
  const acct = await createReadyAccount(baseURL!, { tag: 'smoke' })
  expect(acct.email).toContain('@example.com')
})
