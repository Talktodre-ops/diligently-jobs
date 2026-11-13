import { expect, test, type Page } from '@playwright/test'
import { createReadyAccount, PASSWORD } from '../support/account'
import { latestMail } from '../support/outbox'
import { cachedAccount, openSignedIn, signInForm } from '../support/session'

// Settings and profile tests share one cached account. The destructive ones
// (password change, delete) use a fresh account each run. Sign-ins are limited
// to 20 per 15 minutes per address for everyone on this machine, so cookies are
// reused (see support/session.ts) and second devices sign in through the API.

const shot = (page: Page, name: string, project: string) => page.screenshot({ path: `shots/account/${name}-${project}.png`, fullPage: true })
const NAME = 'Ada Okafor'

/** A tiny one-page PDF with real text, enough for the CV reader. */
let main: { email: string; password: string; name: string }
test.beforeAll(async ({ baseURL }) => {
  main = await cachedAccount('main', () => createReadyAccount(baseURL!, { tag: 'account' }))
})

test('profile shows who you are, edits only what changed and keeps it after a reload', async ({ page, baseURL }, info) => {
  await openSignedIn(page, main, '/profile')
  await expect(page.getByRole('heading', { name: 'Profile', level: 1 })).toBeVisible()
  await expect(page.getByText(NAME, { exact: true })).toBeVisible()
  await expect(page.getByText('Northfold · Senior Backend Engineer · 2021 to Present')).toBeVisible()
  await shot(page, 'profile', info.project.name)

  const patches: string[] = []
  page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().endsWith('/v1/profile')) patches.push(r.postData() ?? '') })
  const stamp = Date.now() % 1000
  const location = `Abuja ${stamp}`
  const headline = `Staff Backend Engineer ${stamp}`
  await page.getByRole('button', { name: 'Edit your details' }).click()
  await shot(page, 'profile-edit', info.project.name)
  await page.getByLabel('Location').fill(location)
  await page.getByLabel('Headline').fill(headline)
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(`${headline} · ${location}`)).toBeVisible()
  expect(patches).toEqual([JSON.stringify({ headline, location })])

  await page.getByRole('button', { name: 'Edit what you are looking for' }).click()
  await page.getByLabel('Roles you want').fill('Platform Engineer, Backend Engineer')
  await page.getByLabel('Hybrid').check()
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Platform Engineer', { exact: true })).toBeVisible()
  await expect(page.getByText('Hybrid', { exact: true })).toBeVisible()

  await page.reload()
  await expect(page.getByText(`${headline} · ${location}`)).toBeVisible()
  await expect(page.getByText('Hybrid', { exact: true })).toBeVisible()
  void baseURL
})

test('profile replaces the master CV by uploading a new file', async ({ page, baseURL }, info) => {
  test.skip(info.project.name !== 'mobile', 'one upload run is enough, it spends real AI money')
  test.setTimeout(120_000)
  // Its own account: replacing the shared one's CV would break the profile test on the next run.
  const own = await createReadyAccount(baseURL!, { tag: 'upload' })
  await signInForm(page, own.email, own.password)
  await page.goto('/profile')
  // The shared fixture (e2e/fixtures/make-fixtures.mjs) is a text PDF the
  // reader reliably parses; a hand-drawn PDF without a clear name gets
  // rejected as "may not be a CV", which is correct behaviour, not a pass.
  await page.getByLabel('Choose a CV file').setInputFiles(new URL('../fixtures/sample-cv.pdf', import.meta.url).pathname)
  await expect(page.getByText(/Your master CV is replaced with sample-cv\.pdf/)).toBeVisible({ timeout: 90_000 })
  await expect(page.getByText('Last replaced')).toBeVisible()
  await shot(page, 'profile-uploaded', info.project.name)
})

test('settings: paper, theme and notifications save, and the theme is applied app-wide', async ({ page, baseURL }, info) => {
  await openSignedIn(page, main, '/settings')
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
  await expect(page.getByText('Applications this month')).toBeVisible()
  await expect(page.getByRole('button', { name: new RegExp(`Email\\s*${main.email}`) })).toBeVisible()
  await shot(page, 'settings-light', info.project.name)

  const html = page.locator('html')
  await page.getByRole('radio', { name: 'Dark' }).click()
  await expect(html).toHaveAttribute('data-theme', 'dark')
  await expect(page.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true')
  await page.waitForTimeout(400) // let the colour transitions finish before the picture
  await shot(page, 'settings-dark', info.project.name)

  await page.getByRole('radio', { name: 'US Letter' }).click()
  const news = page.getByRole('switch', { name: 'Product news' })
  const before = await news.getAttribute('aria-checked')
  await news.click()
  await expect(news).toHaveAttribute('aria-checked', before === 'true' ? 'false' : 'true')

  // Every other page gets the theme too, and it survives a reload.
  await page.goto('/jobs')
  await expect(html).toHaveAttribute('data-theme', 'dark')
  await shot(page, 'jobs-dark', info.project.name)
  await page.goto('/profile')
  await expect(html).toHaveAttribute('data-theme', 'dark')
  await shot(page, 'profile-dark', info.project.name)
  await page.goto('/settings')
  await expect(page.getByRole('radio', { name: 'US Letter' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('switch', { name: 'Product news' })).toHaveAttribute('aria-checked', before === 'true' ? 'false' : 'true')

  await page.getByRole('radio', { name: 'Light' }).click()
  await expect(html).toHaveAttribute('data-theme', 'light')
  await page.getByRole('radio', { name: 'System' }).click()
  await expect(html).not.toHaveAttribute('data-theme', /.*/)
  // Put the account back as it was.
  await page.getByRole('radio', { name: 'A4' }).click()
  await news.click()
  await expect(page.getByRole('radio', { name: 'A4' })).toHaveAttribute('aria-checked', 'true')
  void baseURL
})

test('settings: export downloads a JSON file with the account in it', async ({ page }, info) => {
  await openSignedIn(page, main, '/settings')
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /Download my data/ }).click(),
  ])
  expect(download.suggestedFilename()).toMatch(/^diligently-export-\d{4}-\d{2}-\d{2}\.json$/)
  const path = await download.path()
  const fs = await import('node:fs/promises')
  const data = JSON.parse(await fs.readFile(path, 'utf8'))
  expect(data.account.email).toBe(main.email)
  await expect(page.getByText(/Downloaded diligently-export/)).toBeVisible()
  void info
})

test('settings: change email sends the confirmation to the new address', async ({ page }, info) => {
  await openSignedIn(page, main, '/settings')
  await page.getByRole('button', { name: new RegExp(`Email\\s*${main.email}`) }).click()
  const dialog = page.getByRole('dialog', { name: 'Change your email' })
  await expect(dialog).toBeVisible()
  await shot(page, 'settings-email-dialog', info.project.name)
  const next = `e2e-new-${Date.now()}-${Math.floor(Math.random() * 1e4)}@example.com`
  await dialog.getByLabel('New email').fill(next)
  await dialog.getByLabel('Current password').fill('not the password')
  await dialog.getByRole('button', { name: 'Send confirmation' }).click()
  await expect(dialog.getByRole('alert')).toBeVisible()
  await dialog.getByLabel('Current password').fill(main.password)
  await dialog.getByRole('button', { name: 'Send confirmation' }).click()
  await expect(page.getByRole('dialog', { name: 'Check your new inbox' })).toContainText(next)
  const mail = await latestMail(next, '/confirm-email')
  expect(mail.to.toLowerCase()).toBe(next)
  await page.getByRole('button', { name: 'Done' }).click()
  // Nothing changed until the link is opened.
  await expect(page.getByRole('button', { name: new RegExp(`Email\\s*${main.email}`) })).toBeVisible()
})

test('settings: revoke another device, then every other device', async ({ page, browser, baseURL }, info) => {
  await openSignedIn(page, main, '/settings')
  const other = async () => {
    const ctx = await browser.newContext({ extraHTTPHeaders: { Origin: baseURL! }, userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0' })
    const res = await ctx.request.post(`${baseURL}/v1/auth/signin`, { data: { email: main.email, password: main.password } })
    expect(res.ok()).toBe(true)
    return ctx
  }
  const one = await other()
  const two = await other()
  await page.reload()
  const rows = page.getByRole('listitem').filter({ hasText: 'Last active' })
  await expect(rows.filter({ hasText: 'This device' })).toHaveCount(1)
  await expect(rows.filter({ hasText: 'Firefox on Linux' })).toHaveCount(2)
  await shot(page, 'settings-devices', info.project.name)

  await rows.filter({ hasText: 'Firefox on Linux' }).first().getByRole('button', { name: /^Sign out/ }).click()
  const confirm = page.getByRole('alertdialog', { name: 'Sign out this device?' })
  await expect(confirm).toContainText('needs your password to get back in')
  await confirm.getByRole('button', { name: 'Sign it out' }).click()
  await expect(rows.filter({ hasText: 'Firefox on Linux' })).toHaveCount(1)
  const alive = async (ctx: typeof one) => (await ctx.request.get(`${baseURL}/v1/auth/me`)).status()
  const statuses = [await alive(one), await alive(two)].sort()
  expect(statuses).toEqual([200, 401])

  await page.getByRole('button', { name: 'Sign out all other devices' }).click()
  await page.getByRole('alertdialog', { name: 'Sign out every other device?' }).getByRole('button', { name: 'Sign them out' }).click()
  await expect(rows).toHaveCount(1)
  expect([await alive(one), await alive(two)]).toEqual([401, 401])
  await expect(page.getByRole('button', { name: 'Sign out all other devices' })).toHaveCount(0)
  await one.close()
  await two.close()
})

test('settings: change password signs other devices out, then delete account goes to welcome', async ({ page, browser, baseURL }, info) => {
  test.setTimeout(120_000)
  const acct = await createReadyAccount(baseURL!, { tag: 'destroy' })
  await signInForm(page, acct.email, acct.password)
  await page.goto('/settings')
  const dev = await browser.newContext({ extraHTTPHeaders: { Origin: baseURL! } })
  expect((await dev.request.post(`${baseURL}/v1/auth/signin`, { data: { email: acct.email, password: acct.password } })).ok()).toBe(true)

  await page.getByRole('button', { name: /^Password/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Change your password' })
  await shot(page, 'settings-password-dialog', info.project.name)
  await dialog.getByLabel('Current password').fill('wrong passphrase 1')
  await dialog.getByLabel('New password').fill('a brand new passphrase 2026')
  await dialog.getByRole('button', { name: 'Change password' }).click()
  await expect(dialog.getByRole('alert')).toBeVisible()
  await dialog.getByLabel('Current password').fill(PASSWORD)
  await dialog.getByRole('button', { name: 'Change password' }).click()
  await expect(page.getByRole('dialog', { name: 'Password changed' })).toBeVisible()
  await page.getByRole('button', { name: 'Done' }).click()
  expect((await dev.request.get(`${baseURL}/v1/auth/me`)).status()).toBe(401)
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
  await dev.close()

  // The old password is gone, the new one works (checked with the delete below).
  await page.getByRole('button', { name: 'Delete account' }).click()
  const del = page.getByRole('alertdialog', { name: 'Delete your account?' })
  await expect(del).toContainText('It cannot be undone')
  await shot(page, 'settings-delete-dialog', info.project.name)
  await del.getByLabel('Your password').fill(PASSWORD)
  await del.getByRole('button', { name: 'Delete everything' }).click()
  await expect(del.getByRole('alert')).toBeVisible()
  await expect(page).toHaveURL(/\/settings/)
  await del.getByRole('button', { name: 'Keep my account' }).click()
  await expect(del).toHaveCount(0)

  await page.getByRole('button', { name: 'Delete account' }).click()
  await del.getByLabel('Your password').fill('a brand new passphrase 2026')
  await del.getByRole('button', { name: 'Delete everything' }).click()
  await expect(page).toHaveURL(/\/welcome$/)
  await shot(page, 'after-delete-welcome', info.project.name)
  const res = await page.request.post('/v1/auth/signin', { data: { email: acct.email, password: 'a brand new passphrase 2026' }, headers: { Origin: baseURL! } })
  expect(res.status()).toBe(401)
})

test('settings: sign out ends the session and returns to welcome', async ({ page, baseURL }, info) => {
  // Its own session through the API, so signing out does not end the cached one.
  const signin = await page.request.post('/v1/auth/signin', { data: { email: main.email, password: main.password }, headers: { Origin: baseURL! } })
  expect(signin.ok()).toBe(true)
  await page.goto('/settings')
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page).toHaveURL(/\/welcome$/)
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.*/)
  expect((await page.request.get('/v1/auth/me')).status()).toBe(401)
  await page.goto('/settings')
  await expect(page).toHaveURL(/\/welcome$/)
  void info
})
