import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { createReadyAccount, freshEmail, PASSWORD } from '../support/account'
import { latestMail, linkIn } from '../support/outbox'
import { retryWhileRateLimited } from '../support/waitForSignup'

const shot = (page: Page, info: TestInfo, name: string) =>
  page.screenshot({ path: `shots/auth/${name}-${info.project.name}.png`, fullPage: true })

// Sign-up is limited to 10 per hour per IP, so flows that create accounts run
// on two viewports only. The screens themselves are captured on all four.
const makesAccounts = (info: TestInfo) => ['mobile', 'desktop'].includes(info.project.name)

async function signIn(page: Page, email: string, password: string) {
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

test('public screens render and validate on the client', async ({ page }, info) => {
  await page.goto('/')
  await expect(page).toHaveURL(/\/welcome$/)
  await expect(page.getByRole('heading', { name: 'Apply from anywhere.' })).toBeVisible()
  await shot(page, info, 'welcome')

  await page.getByRole('link', { name: 'Create an account' }).click()
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible()
  await shot(page, info, 'signup')

  await page.getByLabel('Email').fill('someone@example.com')
  await page.getByLabel('Password', { exact: true }).fill('short')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByText('Use at least 10 characters.')).toBeVisible()
  await page.getByLabel('Password', { exact: true }).fill('someone@example.com')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByText('cannot be your email address')).toBeVisible()
  await shot(page, info, 'signup-error')

  await page.getByRole('link', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
  await shot(page, info, 'signin')
  await signIn(page, 'nobody@example.com', 'definitely not right')
  await expect(page.getByRole('alert')).toContainText('do not match')
  await shot(page, info, 'signin-error')

  await page.getByRole('link', { name: 'Forgot password?' }).click()
  await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible()
  await shot(page, info, 'forgot')
  await page.getByLabel('Email').fill(freshEmail('ghost'))
  await page.getByRole('button', { name: 'Send reset link' }).click()
  // The same confirmation for an address that has no account.
  await expect(page.getByRole('heading', { name: 'Link sent' })).toBeVisible()
  await expect(page.getByRole('status')).toContainText('If an account exists')
  await shot(page, info, 'forgot-sent')
})

test('expired and incomplete email links explain themselves', async ({ page }, info) => {
  await page.goto('/verify-email?token=not-a-real-token')
  await expect(page.getByRole('heading', { name: 'That link has expired' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible()
  await shot(page, info, 'verify-expired')

  await page.goto('/reset-password')
  await expect(page.getByRole('heading', { name: 'This link is incomplete' })).toBeVisible()

  await page.goto('/reset-password?token=not-a-real-token')
  await page.getByLabel('New password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Save password' }).click()
  await expect(page.getByRole('alert')).toContainText(/./)
  await expect(page.getByRole('link', { name: 'Send a new link' })).toBeVisible()
  await shot(page, info, 'reset-expired')

  await page.goto('/confirm-email?token=not-a-real-token')
  await expect(page.getByRole('heading', { name: 'That link has expired' })).toBeVisible()
  await shot(page, info, 'confirm-expired')
})

test('sign up, resend, verify from the email, sign out and back in', async ({ page, baseURL }, info) => {
  test.skip(!makesAccounts(info), 'creates an account')
  const email = freshEmail('signup')

  test.setTimeout(120_000)
  await page.goto('/signup')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  // The shared dev stack may have used up the hourly sign-up allowance: wait it out, as the screen tells a person to.
  await retryWhileRateLimited(async () => {
    await page.getByRole('button', { name: 'Create account' }).click()
    await expect(page.getByText(/Too many attempts/).or(page.getByRole('heading', { name: 'Check your email' }))).toBeVisible()
    if (await page.getByText(/Too many attempts/).isVisible()) throw new Error('429 rate_limited')
  })

  await expect(page).toHaveURL(/\/verify-email$/)
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
  await expect(page.getByText(email)).toBeVisible()
  await shot(page, info, 'verify-email')

  // Wrong password on a real account, then the right one. An unverified account is held at verify-email.
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/welcome$/)
  await page.getByRole('link', { name: 'I have an account' }).click()
  await signIn(page, email, 'the wrong passphrase')
  await expect(page.getByRole('alert')).toContainText('do not match')
  await signIn(page, email, PASSWORD)
  await expect(page).toHaveURL(/\/verify-email$/)

  await page.getByRole('button', { name: 'send it again' }).click()
  await expect(page.getByText('Sent a fresh link.')).toBeVisible()
  await expect(page.getByText(/send it again in \d+s/)).toBeVisible()
  await shot(page, info, 'verify-email-resent')

  // Open the newest link from the outbox, as a person would from their inbox.
  const link = linkIn(await latestMail(email, '/verify-email'), '/verify-email')
  expect(link.startsWith(baseURL!)).toBe(true)
  await page.goto(link)
  await expect(page).toHaveURL(/\/onboarding\/upload$/)
  await expect(page.getByRole('heading', { name: 'Start with your CV' })).toBeVisible()

  // The link only works once. Signed in, the page offers a fresh one.
  await page.goto(link)
  await expect(page.getByRole('heading', { name: 'That link has expired' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Send me a new link/ })).toBeVisible()
  await shot(page, info, 'verify-used')

  // The address is taken now.
  await page.context().clearCookies()
  await page.goto('/signup')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByText('already exists')).toBeVisible()
})

test('forgot password, reset from the email, then sign in with it', async ({ page, baseURL }, info) => {
  test.skip(!makesAccounts(info), 'creates an account')
  test.setTimeout(120_000)
  const acct = await retryWhileRateLimited(() => createReadyAccount(baseURL!, { tag: 'reset' }))
  const next = 'a brand new passphrase 2027'

  await page.goto('/forgot-password')
  await page.getByLabel('Email').fill(acct.email)
  await page.getByRole('button', { name: 'Send reset link' }).click()
  await expect(page.getByRole('heading', { name: 'Link sent' })).toBeVisible()

  const link = linkIn(await latestMail(acct.email, '/reset-password'), '/reset-password')
  await page.goto(link)
  await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible()
  await shot(page, info, 'reset')
  await page.getByLabel('New password').fill('short')
  await page.getByRole('button', { name: 'Save password' }).click()
  await expect(page.getByText('Use at least 10 characters.')).toBeVisible()
  await page.getByLabel('New password').fill(next)
  await page.getByRole('button', { name: 'Save password' }).click()
  // Reset signs this device in, and the account is onboarded, so it lands on Home.
  await expect(page).toHaveURL(/\/$/)

  await page.request.post('/v1/auth/signout', { headers: { Origin: baseURL! } })
  await page.goto('/signin')
  await signIn(page, acct.email, acct.password)
  await expect(page.getByRole('alert')).toContainText('do not match')
  await signIn(page, acct.email, next)
  await expect(page).toHaveURL(/\/$/)

  // A visitor bounced from a deep link returns to it after signing in.
  await page.request.post('/v1/auth/signout', { headers: { Origin: baseURL! } })
  await page.goto('/jobs')
  await expect(page).toHaveURL(/\/welcome$/)
  await page.getByRole('link', { name: 'I have an account' }).click()
  await signIn(page, acct.email, next)
  await expect(page).toHaveURL(/\/jobs$/)
})

test('a rate limited sign in shows the wait, from a mocked 429', async ({ page }, info) => {
  await page.route('**/v1/auth/signin', (route) =>
    route.fulfill({
      status: 429,
      contentType: 'application/json',
      headers: { 'Retry-After': '120' },
      body: JSON.stringify({ error: { code: 'rate_limited', message: 'Too many attempts. Wait a little and try again.' } }),
    }),
  )
  await page.goto('/signin')
  await signIn(page, 'someone@example.com', 'whatever passphrase')
  await expect(page.getByRole('alert')).toContainText('Too many attempts. Try again in 2 minutes.')
  await shot(page, info, 'signin-rate-limited')
})
