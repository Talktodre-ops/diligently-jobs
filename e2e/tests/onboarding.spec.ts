import { expect, request, test, type Page, type TestInfo } from '@playwright/test'
import { freshEmail, PASSWORD } from '../support/account'
import { latestMail, linkIn } from '../support/outbox'
import { retryWhileRateLimited } from '../support/waitForSignup'

// Every upload is read by the real Claude API and costs money, and a started
// application runs the whole tailoring pipeline. So: the PDF walk runs on one
// phone and one desktop, DOCX once on the tablet, pasted text once on the wide
// screen, and only that wide run starts a real first job. Sign-up is also
// limited to 10 per hour per IP.
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

async function profile(page: Page) {
  return (await (await page.request.get('/v1/profile')).json()).profile
}

/** Waits for the read to finish and the line-by-line reveal to play out. */
async function waitForRead(page: Page) {
  await expect(page.getByRole('heading', { name: 'That is you, right?' })).toBeVisible({ timeout: 150_000 })
  await expect(page.getByRole('list', { name: 'What we read' }).getByText('Skills')).toBeVisible()
  await page.waitForTimeout(1200)
}

/** Fixes the flagged dates if the reader flagged them, checking Continue is held back until then. */
async function fixDatesIfFlagged(page: Page, info: TestInfo) {
  const flagged = page.getByRole('region', { name: 'Needs your input' })
  if (!(await flagged.first().isVisible())) return false
  await expect(page.getByRole('button', { name: /to continue$/ })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Fix later in Profile' })).toBeVisible()
  await shot(page, info, 'check')
  const card = flagged.filter({ has: page.getByLabel('Started') }).first()
  await card.getByLabel('Started').fill('Jan 2016')
  await card.getByLabel('Ended').fill('Jun 2018')
  await card.getByRole('button', { name: 'Save dates' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Jan 2016 to Jun 2018' })).toBeVisible()
  return true
}

const JOB = `Senior Backend Engineer, Payments Platform at Fernhill Bank (fictional), London or remote in the UK.
We are hiring a senior backend engineer to own the ledger and settlement services behind our card products.
You will design Postgres schemas for high write volumes, build event driven services in Go and Kafka, and run
them on Kubernetes with Terraform. You will lead incident reviews, mentor two mid-level engineers, and work with
risk and finance on reconciliation. Requirements: 6+ years building backend services, strong Go or Rust, deep
Postgres experience, Kafka or a similar log, production on-call experience. Nice to have: card scheme knowledge,
PCI DSS, experience moving batch jobs to streaming. We offer a hybrid or remote setup, 30 days of leave and a
learning budget.`

test('a PDF goes through every step, a fix and a stronger bullet, then Home', async ({ page, baseURL }, info) => {
  test.skip(!['mobile', 'desktop'].includes(info.project.name), 'one phone and one desktop run, uploads cost money')
  test.setTimeout(300_000)
  const acct = await verifiedAccount(baseURL!)

  await test.step('sign in lands on the first onboarding step', async () => {
    await signInThroughForm(page, acct.email, acct.password)
    await expect(page).toHaveURL(/\/onboarding\/upload$/)
    await expect(page.getByRole('heading', { name: 'Bring your CV' })).toBeVisible()
    await expect(page.getByRole('list', { name: 'Setup steps' }).locator('[aria-current="step"]')).toContainText('Your CV')
    await expect(page.getByText('About 3 minutes left')).toBeVisible()
    await shot(page, info, 'upload-idle')
  })

  await test.step('the LinkedIn how-to opens in place', async () => {
    const toggle = page.getByRole('button', { name: 'No CV? Use your LinkedIn profile' })
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByText('Tap Resources, then Save to PDF')).toBeVisible()
    await shot(page, info, 'upload-linkedin')
    await toggle.click()
  })

  await test.step('the client refuses the wrong type and oversize files', async () => {
    await page.getByLabel('CV file').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not a cv') })
    await expect(page.getByRole('alert')).toContainText('Choose a PDF or Word (DOCX) file.')
    await page.getByLabel('CV file').setInputFiles({ name: 'huge.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(5 * 1024 * 1024 + 1) })
    await expect(page.getByRole('alert')).toContainText('over 5 MB')
  })

  await test.step('upload a real PDF, watch the read, see what was read', async () => {
    await page.getByLabel('CV file').setInputFiles('fixtures/sample-cv.pdf')
    await expect(page.getByRole('status').filter({ hasText: /Uploading|Opening the file|Reading your roles|Collecting|Almost/ })).toBeVisible()
    await page.waitForTimeout(3500)
    await shot(page, info, 'upload-reading')
    await waitForRead(page)
    const found = page.getByRole('list', { name: 'What we read' })
    await expect(found).toContainText('Mara Quill')
    await expect(found).toContainText('Larkspur Payments')
    await expect(page.getByText(/^Read in full/)).toBeVisible()
    if (info.project.name === 'desktop') {
      // The CV on the right has filled in.
      await expect(page.getByRole('complementary', { name: 'Your CV as we read it' })).toContainText('Quarry Labs')
    }
    await shot(page, info, 'upload-done')
  })

  await test.step('a reload keeps the saved CV', async () => {
    await page.reload()
    await expect(page.getByRole('heading', { name: 'That is you, right?' })).toBeVisible()
    await expect(page.getByText('Saved to your account')).toBeVisible()
    await page.getByRole('button', { name: 'Looks like me, continue' }).click()
    await expect(page).toHaveURL(/\/onboarding\/check$/)
  })

  await test.step('fix what is flagged', async () => {
    await expect(page.getByRole('list', { name: 'Setup steps' }).locator('[aria-current="step"]')).toContainText('Check')
    const fixed = await fixDatesIfFlagged(page, info)
    if (!fixed) await shot(page, info, 'check')
  })

  await test.step('strengthen one bullet with a number, skip the rest', async () => {
    const card = page.getByRole('form', { name: 'Add a number to a bullet' })
    await expect(card).toBeVisible()
    const original = (await card.locator('blockquote').innerText()).trim()
    await card.getByLabel('What number goes with this?').fill('across 12 services')
    const merged = `${original.replace(/\.+$/, '')}, across 12 services.`
    await expect(card.getByLabel('Your bullet will read')).toHaveValue(merged)
    await shot(page, info, 'check-strengthen')
    await card.getByRole('button', { name: 'Add it' }).click()
    // Skip whatever is left; the loop ends with a done line.
    for (let i = 0; i < 3; i++) {
      const skip = page.getByRole('button', { name: 'I do not know' })
      if (!(await skip.isVisible())) break
      await skip.click()
    }
    await expect(page.getByRole('status').filter({ hasText: /^Done\./ })).toBeVisible()
    await shot(page, info, 'check-done')
    const cv = (await (await page.request.get('/v1/cv/master')).json()).cv
    const bullets: string[] = cv.doc.experience.flatMap((e: { bullets: string[] }) => e.bullets)
    expect(bullets).toContain(merged)
    if (await page.getByText('Jan 2016 to Jun 2018').first().isVisible()) {
      expect(cv.doc.experience.some((e: { start: string; end: string }) => e.start === 'Jan 2016' && e.end === 'Jun 2018')).toBe(true)
    }
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await expect(page).toHaveURL(/\/onboarding\/targets$/)
  })

  await test.step('targets: roles from the CV, setting, location, open to, paper', async () => {
    await page.reload()
    await expect(page.getByRole('heading', { name: 'What are you going for?' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Senior Backend Engineer', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await shot(page, info, 'targets')

    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByText('Choose at least one.')).toBeVisible()

    await page.getByRole('button', { name: '+ Another', exact: true }).click()
    await page.getByLabel('Another role').fill('Platform Engineer')
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Platform Engineer' })).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: 'Remote', exact: true }).click()
    await page.getByRole('button', { name: 'Hybrid', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Remote', exact: true })).toHaveAttribute('aria-pressed', 'true')

    if (!(await page.getByLabel('Where you are based').isVisible())) await page.getByRole('button', { name: /^Change/ }).click()
    await page.getByLabel('Where you are based').fill('London, United Kingdom')
    await page.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(page.getByText('Based in')).toContainText('London, United Kingdom')
    await page.getByRole('button', { name: 'Remote anywhere' }).click()
    await expect(page.getByText('CVs print on A4, the standard in United Kingdom.')).toBeVisible()
    await page.getByRole('button', { name: 'Use US Letter' }).click()
    await expect(page.getByText(/CVs print on US Letter/)).toBeVisible()
    await shot(page, info, 'targets-filled')
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page).toHaveURL(/\/onboarding\/first-job$/)

    const p = await profile(page)
    expect(p.onboarding_step).toBe('first_job')
    expect(p.target_roles).toEqual(expect.arrayContaining(['Senior Backend Engineer', 'Platform Engineer']))
    expect([...p.work_settings].sort()).toEqual(['hybrid', 'remote'])
    expect(p.location).toBe('London, United Kingdom')
    expect(p.open_to).toEqual(['Remote anywhere'])
    expect(p.paper_size).toBe('letter')
  })

  await test.step('the gates send a first_job account to the first job screen', async () => {
    await page.goto('/')
    await expect(page).toHaveURL(/\/onboarding\/first-job$/)
  })

  await test.step('first job: the composer, then skip to Home', async () => {
    await expect(page.getByRole('heading', { name: 'Now the good part. Which job?' })).toBeVisible()
    await expect(page.getByText(/^Uses 1 of/)).toBeVisible()
    await page.getByRole('button', { name: 'Tailor my CV' }).click()
    await expect(page.getByRole('alert')).toContainText('Paste a job link or the job description first.')
    await shot(page, info, 'first-job')
    await page.getByRole('button', { name: 'No job in mind yet? Go to Home' }).click()
    await expect(page).toHaveURL(/\/$/)
    expect((await profile(page)).onboarding_step).toBe('done')
    await page.goto('/onboarding/upload')
    await expect(page).toHaveURL(/\/$/)
  })
})

test('a DOCX upload is read too', async ({ page, baseURL }, info) => {
  test.skip(info.project.name !== 'tablet', 'one tablet run, uploads cost money')
  test.setTimeout(200_000)
  const acct = await verifiedAccount(baseURL!)
  await signInThroughForm(page, acct.email, acct.password)
  await expect(page).toHaveURL(/\/onboarding\/upload$/)
  await shot(page, info, 'upload-idle')
  await page.getByLabel('CV file').setInputFiles('fixtures/sample-cv.docx')
  await waitForRead(page)
  await expect(page.getByText('sample-cv.docx')).toBeVisible()
  await expect(page.getByRole('list', { name: 'What we read' })).toContainText('Mara Quill')
  await shot(page, info, 'upload-done')
  await page.getByRole('button', { name: 'Looks like me, continue' }).click()
  await expect(page).toHaveURL(/\/onboarding\/check$/)
  await shot(page, info, 'check')
})

const PASTED = `Mara Quill
Senior Backend Engineer
mara.quill@example.com, London

Experience
Senior Backend Engineer, Larkspur Payments, London, 2021 to Present
Cut ledger reconciliation time by 60% by moving batch jobs to Kafka consumers in Go
Led a four person on-call rotation and wrote the incident runbooks
Backend Engineer, Quarry Labs, Leeds, 2018 to 2021
Built the billing API in Rust used by 30 merchant integrations
Software Engineer, Kestrel Systems, Leeds
Shipped internal REST APIs for the logistics team

Education
University of Leeds, B.Sc. Computer Science

Skills
Go, Rust, SQL, Postgres, Kafka, Kubernetes, Terraform`

test('pasted text is read, a fix can wait, and the first job starts tailoring', async ({ page, baseURL }, info) => {
  test.skip(info.project.name !== 'wide', 'one wide run: an upload and a real tailoring pipeline cost money')
  test.setTimeout(300_000)
  const acct = await verifiedAccount(baseURL!)
  await signInThroughForm(page, acct.email, acct.password)
  await expect(page).toHaveURL(/\/onboarding\/upload$/)
  await shot(page, info, 'upload-idle')

  await page.getByRole('button', { name: 'Paste the text' }).click()
  await page.getByLabel('Your CV as text').fill('Too short to be a CV.')
  await page.getByRole('button', { name: 'Read it' }).click()
  await expect(page.getByRole('alert')).toContainText('looks short for a CV')
  await page.getByLabel('Your CV as text').fill(PASTED)
  await shot(page, info, 'upload-paste')
  await page.getByRole('button', { name: 'Read it' }).click()
  await waitForRead(page)
  await expect(page.getByText('Pasted text')).toBeVisible()
  await expect(page.getByRole('complementary', { name: 'Your CV as we read it' })).toContainText('Larkspur Payments')
  await shot(page, info, 'upload-done')
  await page.getByRole('button', { name: 'Looks like me, continue' }).click()
  await expect(page).toHaveURL(/\/onboarding\/check$/)
  await shot(page, info, 'check')

  // Whatever is flagged, nobody is stuck: the quiet escape moves on.
  if (await page.getByRole('button', { name: 'Fix later in Profile' }).isVisible()) {
    await page.getByRole('button', { name: 'Fix later in Profile' }).click()
  } else {
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
  }
  await expect(page).toHaveURL(/\/onboarding\/targets$/)
  await page.getByRole('button', { name: 'Remote', exact: true }).click()
  await shot(page, info, 'targets')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page).toHaveURL(/\/onboarding\/first-job$/)

  await page.getByLabel('Job link or description').fill(JOB)
  await shot(page, info, 'first-job')
  await page.getByRole('button', { name: 'Tailor my CV' }).click()
  await expect(page).toHaveURL(/\/applications\/[0-9a-f-]+\/running$/, { timeout: 30_000 })
  expect((await profile(page)).onboarding_step).toBe('done')
  await expect(page.getByRole('heading', { name: 'Working on it' })).toBeVisible()
  await shot(page, info, 'first-job-running')
})

test('starting from scratch needs only a name', async ({ page, baseURL }, info) => {
  test.skip(info.project.name !== 'desktop', 'one desktop run, no AI involved')
  test.setTimeout(120_000)
  const acct = await verifiedAccount(baseURL!)
  await signInThroughForm(page, acct.email, acct.password)
  await expect(page).toHaveURL(/\/onboarding\/upload$/)
  await page.getByRole('button', { name: 'Start from scratch' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText('Enter your name')).toBeVisible()
  await page.getByLabel('Full name').fill('Mara Quill')
  await shot(page, info, 'upload-by-hand')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page).toHaveURL(/\/onboarding\/check$/)

  // An empty CV flags everything the API flags, each with its own inline fix, and the CV on the right marks them.
  const cards = page.getByRole('region', { name: 'Needs your input' })
  await expect(cards.filter({ hasText: 'Add a headline' })).toBeVisible()
  await expect(cards.filter({ hasText: 'No experience found' })).toBeVisible()
  await expect(page.getByRole('complementary', { name: 'Your master CV' })).toContainText('Headline missing')
  await expect(page.getByRole('button', { name: 'Fix these to continue' })).toBeDisabled()
  await shot(page, info, 'check-issues')
  const headline = cards.filter({ hasText: 'Add a headline' })
  await headline.getByLabel('Headline').fill('Backend Engineer')
  await headline.getByRole('button', { name: 'Save headline' }).click()
  await expect(cards.filter({ hasText: 'Add a headline' })).toHaveCount(0)
  await expect(page.getByRole('status').filter({ hasText: 'Headline: Backend Engineer' })).toBeVisible()
  const role = cards.filter({ hasText: 'No experience found' })
  await role.getByLabel('Job title').fill('Backend Engineer')
  await role.getByLabel('Company').fill('Larkspur Payments')
  await role.getByLabel('Started').fill('2021')
  await role.getByLabel('Ended').fill('Present')
  await role.getByLabel('What you did').fill('Built the ledger\nRan the on-call rotation')
  await role.getByRole('button', { name: 'Add role' }).click()
  await expect(page.getByRole('complementary', { name: 'Your master CV' })).toContainText('Larkspur Payments')
  await shot(page, info, 'check-after-fixes')
})
