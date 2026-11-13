import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { expect, type BrowserContext, type Page } from '@playwright/test'

// The API limits sign-ins to 20 per 15 minutes per address, shared by every
// agent and spec on this machine. So a spec signs in through the real form
// once per account, keeps the cookies in e2e/.cache, and later tests reuse
// them until the session is revoked.
const dir = '.cache'
const file = (email: string) => `${dir}/cookies-${email.replace(/[^a-z0-9]/gi, '_')}.json`

export async function signInForm(page: Page, email: string, password: string) {
  await page.goto('/signin')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: /^sign in$/i }).click()
  await expect(page).not.toHaveURL(/\/signin/)
}

/** Signed in at `path`: cached cookies if they still work, else the real form. */
export async function openSignedIn(page: Page, acct: { email: string; password: string }, path: string) {
  const context: BrowserContext = page.context()
  const f = file(acct.email)
  if (existsSync(f)) {
    await context.addCookies(JSON.parse(readFileSync(f, 'utf8')))
    await page.goto(path)
    await page.waitForLoadState('networkidle')
    if (!/\/(welcome|signin)/.test(page.url())) return
    await context.clearCookies()
  }
  await signInForm(page, acct.email, acct.password)
  mkdirSync(dir, { recursive: true })
  writeFileSync(f, JSON.stringify(await context.cookies()))
  await page.goto(path)
}

/** A named account kept between runs; delete e2e/.cache/account-<name>.json to make a new one. */
export async function cachedAccount(
  name: string,
  make: () => Promise<{ email: string; password: string; name: string }>,
) {
  const f = `${dir}/account-${name}.json`
  if (existsSync(f)) {
    const a = JSON.parse(readFileSync(f, 'utf8')) as { email: string; password: string; name: string }
    return a
  }
  const a = await make()
  mkdirSync(dir, { recursive: true })
  writeFileSync(f, JSON.stringify(a))
  return a
}
