import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { createVerifiedAccount } from '../support/account'
import { signInForm } from '../support/session'
import { retryWhileRateLimited } from '../support/waitForSignup'

// Setup as milestones: every onboarding step can wait, Home holds what is
// left, and Hide keeps the card away for a week on every device. No AI runs
// here: the CV is started from scratch.
const shot = (page: Page, info: TestInfo, name: string) =>
  page.screenshot({ path: `shots/setup/${name}-${info.project.name}.png`, fullPage: true })

const JD = 'Senior Backend Engineer at Northfold. You will own the payments ledger in Rust and Postgres, work with finance on reconciliation, and run the on-call rotation for the money-moving services. '.repeat(2)

test('skip setup, find it on Home, and hide it everywhere for a week', async ({ page, browser, baseURL }, info) => {
  const acct = await retryWhileRateLimited(() => createVerifiedAccount(baseURL!, 'setup'))
  await signInForm(page, acct.email, acct.password)
  await expect(page).toHaveURL(/\/onboarding\/upload$/)

  await test.step('Do this later goes Home, and Home no longer sends the user back', async () => {
    await page.getByRole('button', { name: 'Do this later' }).click()
    await expect(page).toHaveURL(/\/$/)
    await page.reload()
    await expect(page).toHaveURL(/\/$/)
  })

  const card = page.getByRole('region', { name: 'Get set up' })
  await test.step('the card lists all four steps, the CV ones closed until there is a CV', async () => {
    await expect(card.getByText('0 of 4 done')).toBeVisible()
    await expect(card.getByRole('link', { name: /Add your CV/ })).toHaveAttribute('href', '/onboarding/upload')
    await expect(card.getByRole('link', { name: /Say what you want/ })).toHaveAttribute('href', '/onboarding/targets')
    await expect(card.getByRole('link', { name: /Check what we read/ })).toHaveCount(0)
    await expect(card.getByText('After you add your CV.')).toHaveCount(2)
    await shot(page, info, 'home-card')
  })

  await test.step('Hide keeps it away after a reload and on another device', async () => {
    await card.getByRole('button', { name: 'Hide' }).click()
    await expect(card).toHaveCount(0)
    await page.reload()
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(card).toHaveCount(0)
    const setup = (await (await page.request.get('/v1/home')).json()).setup
    const days = (Date.parse(setup.hidden_until) - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(6.9)
    expect(days).toBeLessThanOrEqual(7)

    const other = await browser.newContext({ viewport: page.viewportSize() ?? undefined })
    const phone = await other.newPage()
    await signInForm(phone, acct.email, acct.password)
    await expect(phone).toHaveURL(/\/$/)
    await expect(phone.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(phone.getByRole('region', { name: 'Get set up' })).toHaveCount(0)
    await other.close()
  })
})

test('a job pasted before a CV waits while the CV is added', async ({ page, baseURL }, info) => {
  test.skip(info.project.name !== 'mobile' && info.project.name !== 'desktop', 'one phone and one desktop run')
  const acct = await retryWhileRateLimited(() => createVerifiedAccount(baseURL!, 'nocv'))
  await signInForm(page, acct.email, acct.password)
  await page.getByRole('button', { name: 'Do this later' }).click()
  await expect(page).toHaveURL(/\/$/)

  await page.goto('/new')
  await page.getByLabel('Job description').fill(JD)
  await page.getByRole('button', { name: 'Tailor my CV' }).click()
  await expect(page.getByText(/Add your CV first\./)).toBeVisible()
  await shot(page, info, 'no-cv')
  await page.getByRole('link', { name: 'Add your CV' }).click()
  await expect(page).toHaveURL(/\/onboarding\/upload\?then=%2Fnew$|\/onboarding\/upload\?then=\/new$/)

  await page.getByRole('button', { name: 'Start from scratch' }).click()
  await page.getByLabel('Full name').fill('Ada Okafor')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page).toHaveURL(/\/new$/)
  await expect(page.getByLabel('Job description')).toHaveValue(JD)

  const setup = (await (await page.request.get('/v1/home')).json()).setup
  expect(setup).toMatchObject({ cv: true, check: false, first_application: false })
})
