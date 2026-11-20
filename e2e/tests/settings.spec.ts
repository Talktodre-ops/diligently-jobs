import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { createReadyAccount } from '../support/account'
import { unsubscribeToken } from '../support/db'
import { cachedAccount, openSignedIn } from '../support/session'

// Settings saves each control the moment it changes, the time zone is filled
// from the browser, and the public unsubscribe page works signed out. One
// cached account serves every viewport; each test puts back what it changed.

const shot = (page: Page, info: TestInfo, name: string) =>
  page.screenshot({ path: `shots/settings/${name}-${info.project.name}.png`, fullPage: true })
const wide = (info: TestInfo) => info.project.name === 'desktop' || info.project.name === 'wide'

let acct: { email: string; password: string; name: string }
test.beforeAll(async ({ baseURL }) => {
  acct = await cachedAccount('settings', () => createReadyAccount(baseURL!, { tag: 'settings' }))
})

type Profile = {
  notifications: Record<string, boolean>
  reminders: { follow_up_days: number; send_hour: number; time_zone: string | null; skip_weekends: boolean }
  writing: { spelling: string | null; letter_tone: string }
}
const readProfile = async (page: Page) => (await (await page.request.get('/v1/profile')).json()).profile as Profile

test('every control saves at once and is still there after a reload', async ({ page }, info) => {
  await openSignedIn(page, acct, '/settings')
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Reminders', level: 2 })).toBeVisible()

  // The account gate sends the browser's zone when none is stored.
  const zone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)
  await expect.poll(async () => (await readProfile(page)).reminders.time_zone).toBe(zone)
  expect('interview_prep' in (await readProfile(page)).notifications).toBe(false)
  await shot(page, info, 'settings')

  const summary = page.getByRole('switch', { name: 'Monday summary' })
  const before = await summary.getAttribute('aria-checked')
  const flipped = before === 'true' ? 'false' : 'true'
  await summary.click()
  await expect(summary).toHaveAttribute('aria-checked', flipped)
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible()

  await page.getByRole('radio', { name: '14 days' }).click()
  await page.getByRole('radio', { name: /^Evening/ }).click()
  await page.getByRole('radio', { name: 'Warm' }).click()
  await page.getByRole('radio', { name: 'American' }).click()
  await expect.poll(async () => {
    const p = await readProfile(page)
    return [p.reminders.follow_up_days, p.reminders.send_hour, p.writing.letter_tone, p.writing.spelling]
  }).toEqual([14, 18, 'warm', 'en-US'])

  await page.reload()
  await expect(page.getByRole('switch', { name: 'Monday summary' })).toHaveAttribute('aria-checked', flipped)
  await expect(page.getByRole('radio', { name: '14 days' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('radio', { name: /^Evening/ })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('radio', { name: 'Warm' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('radio', { name: 'American' })).toHaveAttribute('aria-checked', 'true')

  // Arrow keys move through a choice and save it.
  await page.getByRole('radio', { name: '14 days' }).focus()
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByRole('radio', { name: '10 days' })).toBeFocused()
  await expect.poll(async () => (await readProfile(page)).reminders.follow_up_days).toBe(10)

  // Put it back as it was.
  await page.getByRole('switch', { name: 'Monday summary' }).click()
  await page.getByRole('radio', { name: '7 days' }).click()
  await page.getByRole('radio', { name: /^Morning/ }).click()
  await page.getByRole('radio', { name: 'Direct' }).click()
  await page.getByRole('radio', { name: 'British' }).click()
  await expect.poll(async () => {
    const p = await readProfile(page)
    return [String(p.notifications.weekly_summary), p.reminders.follow_up_days, p.reminders.send_hour, p.writing.letter_tone, p.writing.spelling]
  }).toEqual([before, 7, 9, 'direct', 'en-GB'])
})

test('the time zone is picked from a searchable list', async ({ page }, info) => {
  await openSignedIn(page, acct, '/settings')
  const zone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)
  await expect.poll(async () => (await readProfile(page)).reminders.time_zone).toBe(zone)
  const target = zone === 'Asia/Tokyo' ? { search: 'lagos', city: 'Lagos', iana: 'Africa/Lagos' } : { search: 'tokyo', city: 'Tokyo', iana: 'Asia/Tokyo' }

  await page.getByRole('button', { name: 'Change time zone' }).click()
  const dialog = page.getByRole('dialog', { name: 'Your time zone' })
  await dialog.getByLabel('Search for a city').fill(target.search)
  await shot(page, info, 'time-zone')
  await dialog.getByRole('button', { name: new RegExp(`^${target.city}`) }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByText(new RegExp(`Time zone: ${target.city}`))).toBeVisible()
  await expect.poll(async () => (await readProfile(page)).reminders.time_zone).toBe(target.iana)

  await page.reload()
  await expect(page.getByText(new RegExp(`Time zone: ${target.city}`))).toBeVisible()
  await page.getByRole('button', { name: 'Change time zone' }).click()
  await page.getByRole('dialog', { name: 'Your time zone' }).getByRole('button', { name: /^Use this device/ }).click()
  await expect.poll(async () => (await readProfile(page)).reminders.time_zone).toBe(zone)
})

test('the section nav follows the page on wide screens', async ({ page }, info) => {
  test.skip(!wide(info) && info.project.name !== 'tablet', 'the nav only shows from 900px')
  await openSignedIn(page, acct, '/settings')
  const nav = page.getByRole('navigation', { name: 'Settings sections' })
  if (info.project.name === 'tablet') {
    // 834px is under the breakpoint: phone layout, no nav.
    await expect(nav).toBeHidden()
    return
  }
  await expect(nav.getByRole('link', { name: 'Account' })).toHaveAttribute('aria-current', 'true')
  await nav.getByRole('link', { name: 'Your documents' }).click()
  await expect(page).toHaveURL(/#documents$/)
  await expect(nav.getByRole('link', { name: 'Your documents' })).toHaveAttribute('aria-current', 'true')
  await expect(page.getByRole('heading', { name: 'Your documents', level: 2 })).toBeInViewport()
  await expect(nav).toBeInViewport()
  await page.screenshot({ path: `shots/settings/nav-${info.project.name}.png` })
})

test('unsubscribe works signed out, and Undo turns it back on', async ({ browser, page, baseURL }, info) => {
  let token: string
  try {
    token = unsubscribeToken(acct.email)
  } catch (e) {
    test.skip(true, `could not read the token from the dev database: ${String(e)}`)
    return
  }
  // A context with no cookies: the link must work without a session.
  const ctx = await browser.newContext({ baseURL, viewport: page.viewportSize() ?? undefined })
  const out = await ctx.newPage()
  try {
    await out.goto(`/unsubscribe?token=${token}&kind=weekly_summary`)
    await expect(out.getByRole('heading', { name: 'No more Monday summaries.' })).toBeVisible()
    await expect(out.getByText(/Done for .+\*\*\*@example\.com/)).toBeVisible()
    await out.screenshot({ path: `shots/settings/unsubscribe-${info.project.name}.png`, fullPage: true })
    await openSignedIn(page, acct, '/settings')
    await expect(page.getByRole('switch', { name: 'Monday summary' })).toHaveAttribute('aria-checked', 'false')

    await out.getByRole('button', { name: 'Undo' }).click()
    await expect(out.getByRole('heading', { name: 'Monday summaries are back on.' })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('switch', { name: 'Monday summary' })).toHaveAttribute('aria-checked', 'true')

    await out.goto(`/unsubscribe?token=${'0'.repeat(64)}&kind=weekly_summary`)
    await expect(out.getByRole('heading', { name: 'We do not recognise this link.' })).toBeVisible()
    await out.goto(`/unsubscribe?token=${token}&kind=interview_prep`)
    await expect(out.getByRole('heading', { name: 'This link is not complete.' })).toBeVisible()
  } finally {
    await ctx.close()
  }
})

test('delete with an emailed code, for an account with no password', async () => {
  test.skip(true, 'an account without a password only comes from Google sign-in, which the e2e helpers cannot create; covered by the unit tests in Account.test.tsx')
})
