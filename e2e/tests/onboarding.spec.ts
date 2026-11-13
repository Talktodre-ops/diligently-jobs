import { expect, request, test, type Page, type TestInfo } from '@playwright/test'
import { freshEmail, PASSWORD } from '../support/account'
import { latestMail, linkIn } from '../support/outbox'
import { retryWhileRateLimited } from '../support/waitForSignup'

// Every upload is parsed by the real Claude API and costs money, so the two
// full walks run on one phone and one desktop viewport (PDF), and the DOCX
// upload runs once on the tablet. Sign-up is also limited to 10 per hour per IP.
const shot = (page: Page, info: TestInfo, name: string) =>
  page.screenshot({ path: `shots/onboarding/${name}-${info.project.name}.png`, fullPage: true })

/** A verified account with nothing else done, made through the real API and outbox. */
async function verifiedAccount(baseURL: string) {
  return retryWhileRateLimited(() => createVerified(baseURL))
}

async function createVerified(baseURL: string) {
  const email = freshEmail('onboard')
  const ctx = await request.newContext({ baseURL, extraHTTPHeaders: { Origin: baseURL } })
  try {
    const signup = await ctx.post('/v1/auth/signup', { data: { email, password: PASSWORD } })
    if (signup.status() !== 201) throw new Error(`signup ${signup.status()}: ${await signup.text()}`)
    const token = new URL(linkIn(await latestMail(email, '/verify-email'), '/verify-email')).searchParams.get('token')
    const verify = await ctx.post('/v1/auth/verify', { data: { token } })
    if (!verify.ok()) throw new Error(`verify ${verify.status()}`)
  } finally {
    await ctx.dispose()
  }
  return { email, password: PASSWORD }
}

async function signInThroughForm(page: Page, email: string, password: string) {
  await page.goto('/signin')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

async function uploadFile(page: Page, path: string | { name: string; mimeType: string; buffer: Buffer }) {
  await page.getByLabel('CV file').setInputFiles(path)
}

test('a new account goes from upload to Home with a PDF', async ({ page, baseURL }, info) => {
  test.skip(!['mobile', 'desktop'].includes(info.project.name), 'one phone and one desktop run, uploads cost money')
  test.setTimeout(240_000)
  const acct = await verifiedAccount(baseURL!)

  await test.step('sign in lands on the first onboarding step', async () => {
    await signInThroughForm(page, acct.email, acct.password)
    await expect(page).toHaveURL(/\/onboarding\/upload$/)
    await expect(page.getByRole('heading', { name: 'Start with your CV' })).toBeVisible()
    await expect(page.getByText('Step 1 of 3')).toBeVisible()
    await shot(page, info, 'upload-idle')
  })

  await test.step('the client refuses the wrong type and oversize files', async () => {
    await uploadFile(page, { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not a cv') })
    await expect(page.getByRole('alert')).toContainText('Choose a PDF or DOCX file.')
    await uploadFile(page, { name: 'huge.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(5 * 1024 * 1024 + 1) })
    await expect(page.getByRole('alert')).toContainText('over 5 MB')
    await shot(page, info, 'upload-error')
  })

  await test.step('upload a real PDF and wait for the read', async () => {
    await uploadFile(page, 'fixtures/sample-cv.pdf')
    await page.getByText(/Waiting for a reader|Reading it/).waitFor({ timeout: 5_000 }).catch(() => undefined)
    await shot(page, info, 'upload-reading')
    await expect(page.getByText('Read in full')).toBeVisible({ timeout: 120_000 })
    await expect(page.getByText('sample-cv.pdf')).toBeVisible()
    await expect(page.getByText(/^roles?$/)).toBeVisible()
    await shot(page, info, 'upload-done')
  })

  await test.step('a reload keeps the step and the saved CV', async () => {
    await page.reload()
    await expect(page.getByText('Saved to your account')).toBeVisible()
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page).toHaveURL(/\/onboarding\/check$/)
  })

  await test.step('check the parsed CV and fix what is flagged', async () => {
    await expect(page.getByRole('heading', { name: 'Check what we found' })).toBeVisible()
    await expect(page.getByText('Step 2 of 3')).toBeVisible()
    await expect(page.getByRole('button', { name: /Experience/ })).toBeVisible()
    await expect(page.getByText('Larkspur Payments')).toBeVisible()
    await shot(page, info, 'check')

    const flagged = page.getByRole('region', { name: 'Needs your input' })
    // The sample CV leaves Kestrel without dates, so the parser should flag it.
    if (await flagged.first().isVisible()) {
      await expect(flagged.first()).toContainText('Dates are missing')
      await shot(page, info, 'check-issue')
      await flagged.first().getByLabel('Started').fill('Jan 2016')
      await flagged.first().getByLabel('Ended').fill('Jun 2018')
      await flagged.first().getByRole('button', { name: 'Save dates' }).click()
      await expect(page.getByText('Jan 2016 to Jun 2018')).toBeVisible()
      await shot(page, info, 'check-fixed')
    }
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Check what we found' })).toBeVisible()
    await expect(page.getByText('Jan 2016 to Jun 2018')).toBeVisible()
  })

  await test.step('set targets and finish', async () => {
    await page.getByRole('button', { name: 'Looks right' }).click()
    await expect(page).toHaveURL(/\/onboarding\/targets$/)
    await page.reload()
    await expect(page.getByRole('heading', { name: 'What are you looking for?' })).toBeVisible()
    await expect(page.getByText('Step 3 of 3')).toBeVisible()
    await shot(page, info, 'targets')

    await page.getByRole('button', { name: 'Finish setup' }).click()
    await expect(page.getByText('Add at least one role you are looking for.')).toBeVisible()

    await page.getByLabel('Add a role').fill('Platform Engineer')
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await page.getByRole('button', { name: /^\+ / }).first().click()
    await page.getByRole('button', { name: 'Remote', exact: true }).click()
    await page.getByRole('button', { name: 'Hybrid', exact: true }).click()
    await page.getByLabel('Where you are').fill('London, UK')
    await page.getByRole('button', { name: /US Letter/ }).click()
    await shot(page, info, 'targets-filled')
    await page.getByRole('button', { name: 'Finish setup' }).click()
    await expect(page).toHaveURL(/\/$/)
  })

  await test.step('the profile saved and onboarding no longer reopens', async () => {
    const res = await page.request.get('/v1/profile')
    const { profile } = await res.json()
    expect(profile.onboarding_step).toBe('done')
    expect(profile.target_roles).toContain('Platform Engineer')
    expect(profile.work_settings.sort()).toEqual(['hybrid', 'remote'])
    expect(profile.location).toBe('London, UK')
    expect(profile.paper_size).toBe('letter')
    await page.goto('/onboarding/upload')
    await expect(page).toHaveURL(/\/$/)
  })
})

test('a DOCX upload is read too', async ({ page, baseURL }, info) => {
  test.skip(info.project.name !== 'tablet', 'one tablet run, uploads cost money')
  test.setTimeout(180_000)
  const acct = await verifiedAccount(baseURL!)
  await signInThroughForm(page, acct.email, acct.password)
  await expect(page).toHaveURL(/\/onboarding\/upload$/)
  await shot(page, info, 'upload-idle')
  await uploadFile(page, 'fixtures/sample-cv.docx')
  await expect(page.getByText('Read in full')).toBeVisible({ timeout: 120_000 })
  await expect(page.getByText('sample-cv.docx')).toBeVisible()
  await shot(page, info, 'upload-done')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('heading', { name: 'Check what we found' })).toBeVisible()
  await shot(page, info, 'check')
})

test('building a CV by hand needs only a name', async ({ page, baseURL }, info) => {
  test.skip(info.project.name !== 'wide', 'one wide run, no AI involved')
  test.setTimeout(90_000)
  const acct = await verifiedAccount(baseURL!)
  await signInThroughForm(page, acct.email, acct.password)
  await expect(page).toHaveURL(/\/onboarding\/upload$/)
  await shot(page, info, 'upload-idle')
  await page.getByRole('button', { name: 'Build it by hand instead' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText('Enter your name')).toBeVisible()
  await page.getByLabel('Full name').fill('Mara Quill')
  await shot(page, info, 'upload-by-hand')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page).toHaveURL(/\/onboarding\/check$/)

  // An empty CV flags everything the API flags, each with its own inline fix.
  const cards = page.getByRole('region', { name: 'Needs your input' })
  await expect(cards.filter({ hasText: 'Add a headline' })).toBeVisible()
  await expect(cards.filter({ hasText: 'No experience found' })).toBeVisible()
  await shot(page, info, 'check-issues')
  const headline = cards.filter({ hasText: 'Add a headline' })
  await headline.getByLabel('Headline').fill('Backend Engineer')
  await headline.getByRole('button', { name: 'Save headline' }).click()
  await expect(cards.filter({ hasText: 'Add a headline' })).toHaveCount(0)
  const role = cards.filter({ hasText: 'No experience found' })
  await role.getByLabel('Job title').fill('Backend Engineer')
  await role.getByLabel('Company').fill('Larkspur Payments')
  await role.getByLabel('Started').fill('2021')
  await role.getByLabel('Ended').fill('Present')
  await role.getByLabel('What you did').fill('Built the ledger\nRan the on-call rotation')
  await role.getByRole('button', { name: 'Add role' }).click()
  await expect(page.getByText('Larkspur Payments')).toBeVisible()
  await shot(page, info, 'check-after-fixes')
})
