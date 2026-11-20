import { expect, request, test, type Browser, type Page, type TestInfo } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createReadyAccount } from '../support/account'

// The application screen's CV, Letter and Company tabs, the Download sheet and
// Documents, driven the way a person would after a real pipeline has finished.
//
// The pipeline makes real AI and web-search calls, so one finished
// application is shared by every test and every viewport in a run, and kept
// in e2e/.auth/ (gitignored) for the next run. DOCS_FRESH=1 starts over.
// Sign-in is rate limited per IP, so each viewport signs in once through the
// real form and its tests reuse that session.

const FIXTURE = '.auth/documents-fixture.json'
const sessionFile = (info: TestInfo) => `.auth/documents-session-${info.project.name}.json`

// A fictional posting. The company is real so the research step has public
// pages to read; nothing in the posting is from that company.
const JD = `Senior Backend Engineer, Merchant Payments
Paystack, Lagos (hybrid) or remote within Africa, full time

About the team
The merchant payments team builds the services that move money for businesses across our markets: collecting payments, settling them to merchants and keeping a ledger everyone can trust. We work in small groups that own their services from design to on-call.

What you will do
- Design, build and run backend services in Go that handle payment collection and settlement
- Own the double-entry ledger and the reconciliation jobs that keep it correct
- Move nightly batch jobs to Kafka consumers with clear delivery guarantees
- Model data in Postgres for high write volumes, including partitioning and indexing
- Take part in an on-call rotation and lead incident reviews
- Mentor other engineers and review designs across teams

What we are looking for
- Six or more years building backend systems, with at least three in payments, billing or ledgers
- Strong Go; Rust or another systems language is a plus
- Deep Postgres experience, including schema design for large tables
- Production experience with Kafka or a similar event log
- Experience with infrastructure as code (Terraform) and Kubernetes
- Clear written communication across time zones
- Nice to have: multi-currency settlement, PCI DSS, GraphQL API design

What we offer
Hybrid or remote work, a yearly learning budget, and a small team where engineers own their services end to end.`

type Fixture = { email: string; password: string; applicationId: string; company: string }

/** A ready account with one finished application (research and letter on). */
function savedFixture(): Fixture | null {
  if (process.env.DOCS_FRESH === '1' || !existsSync(FIXTURE)) return null
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture
}

/** Sign-up is limited to a few per hour per IP and other specs share it, so wait for room. */
async function readyAccount(baseURL: string) {
  for (let i = 0; ; i++) {
    try {
      return await createReadyAccount(baseURL, { tag: 'docs' })
    } catch (e) {
      if (!String(e).includes('signup 429') || i >= 12) throw e
      await new Promise((r) => setTimeout(r, 30_000))
    }
  }
}

async function freshFixture(baseURL: string): Promise<Fixture> {
  const acct = await readyAccount(baseURL)
  const api = await request.newContext({ baseURL, extraHTTPHeaders: { Origin: baseURL } })
  try {
    const signin = await api.post('/v1/auth/signin', { data: { email: acct.email, password: acct.password } })
    if (!signin.ok()) throw new Error(`signin ${signin.status()}`)
    const start = await api.post('/v1/applications/start', { data: { jd_text: JD, research: true, letter: true } })
    if (start.status() !== 202) throw new Error(`start ${start.status()}: ${await start.text()}`)
    const { application_id, job_id } = await start.json()
    const deadline = Date.now() + 240_000
    for (;;) {
      const job = await (await api.get(`/v1/jobs/${job_id}`)).json()
      if (job.status === 'done') break
      if (job.status === 'failed') throw new Error(`pipeline failed: ${JSON.stringify(job.progress)}`)
      if (Date.now() > deadline) throw new Error('pipeline took over four minutes')
      await new Promise((r) => setTimeout(r, 2000))
    }
    // The person's own decisions from Review (another area's screen): accept
    // the first rewrite and the summary, so the CV has changes to highlight.
    const rw = await (await api.get(`/v1/applications/${application_id}/rewrites`)).json()
    if (rw.rewrites[0]) await api.patch(`/v1/rewrites/${rw.rewrites[0].id}`, { data: { action: 'accept' } })
    if (rw.summary) await api.patch(`/v1/applications/${application_id}/summary`, { data: { action: 'accept' } })
    const brief = await (await api.get(`/v1/applications/${application_id}/brief`)).json()
    const f: Fixture = { email: acct.email, password: acct.password, applicationId: application_id, company: brief.application.company }
    mkdirSync(dirname(FIXTURE), { recursive: true })
    writeFileSync(FIXTURE, JSON.stringify(f, null, 2))
    return f
  } finally {
    await api.dispose()
  }
}

/** Signs in through the real form; true when the saved application is there and finished. */
async function signIn(page: Page, fx: Fixture): Promise<boolean> {
  await page.goto('/signin')
  await page.getByLabel('Email').fill(fx.email)
  await page.getByLabel('Password', { exact: true }).fill(fx.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  const left = await page.waitForURL((u) => !u.pathname.startsWith('/signin'), { timeout: 10_000 }).then(() => true, () => false)
  if (!left) return false
  const brief = await page.request.get(`/v1/applications/${fx.applicationId}/brief`)
  return brief.ok() && (await brief.json()).pipeline?.status === 'done'
}

/** One form sign-in per viewport; the session is saved for the tests that follow. */
async function signInOnce(browser: Browser, baseURL: string, info: TestInfo): Promise<Fixture> {
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } })
  const page = await context.newPage()
  try {
    let fx = savedFixture()
    if (!fx || !(await signIn(page, fx))) {
      fx = await freshFixture(baseURL)
      if (!(await signIn(page, fx))) throw new Error('could not sign in to the new fixture account')
    }
    await context.storageState({ path: sessionFile(info) })
    return fx
  } finally {
    await context.close()
  }
}

async function shot(page: Page, info: TestInfo, name: string) {
  await page.screenshot({ path: `shots/documents/${name}-${info.project.name}.png`, fullPage: true })
}


let f: Fixture

test.describe.serial('documents', () => {
  test.beforeAll(async ({ browser, baseURL }, info) => {
    test.setTimeout(600_000)
    f = await signInOnce(browser, baseURL!, info)
  })

  test.use({ storageState: async ({}, use, info) => use(sessionFile(info)) })

  test('company tab reads as overview, talking points and sources', async ({ page }, info) => {
    await page.goto(`/applications/${f.applicationId}?tab=company`)
    await expect(page.getByRole('tab', { name: 'Company' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByText(/From \d+ web sources?, gathered/)).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Talking points' })).toBeVisible()
    await shot(page, info, 'research')
    const firstSource = page.getByRole('region', { name: 'Sources' }).getByRole('link').first()
    await expect(firstSource).toHaveAttribute('target', '_blank')
    await expect(firstSource).toHaveAttribute('href', /^https?:\/\//)
    await page.getByRole('tab', { name: 'CV' }).click()
    await expect(page).toHaveURL(new RegExp(`/applications/${f.applicationId}$`))
  })

  test('letter tab: the letter as LaTeX set it, then tone, a paragraph, copy', async ({ page, context }, info) => {
    test.setTimeout(180_000)
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.goto(`/applications/${f.applicationId}?tab=letter`)
    // Page first: the file that gets downloaded.
    const pages = page.getByTestId('pdf-pages')
    await expect(pages).toHaveAttribute('data-status', 'ready', { timeout: 90_000 })
    await expect(page.getByRole('img', { name: /Cover letter page 1 of \d+, as rendered/ })).toBeVisible()
    await shot(page, info, 'letter-page')

    const views = page.getByRole('group', { name: 'How to show your letter' })
    await views.getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(page).toHaveURL(/[?&]view=edit/)
    const letter = page.getByRole('article', { name: 'Your cover letter' })
    await expect(letter).toBeVisible()
    await expect(page.getByText(/^\d+ words$/)).toBeVisible()

    const tones = page.getByRole('group', { name: 'Tone' })
    const current = (await tones.getByRole('button', { pressed: true }).textContent())?.trim()
    const next = current === 'Warm' ? 'Formal' : 'Warm'
    await tones.getByRole('button', { name: next }).click()
    await expect(page.getByRole('status').filter({ hasText: `Writing a ${next.toLowerCase()} version` })).toBeVisible()
    await expect(tones.getByRole('button', { name: next })).toHaveAttribute('aria-pressed', 'true', { timeout: 90_000 })
    await expect(letter).not.toHaveAttribute('aria-busy', 'true')

    const second = letter.getByRole('button').nth(1)
    await second.click()
    const box = page.getByLabel('Paragraph 2')
    await expect(box).toBeFocused()
    const added = 'I would bring the same care to your settlement services.'
    await box.fill(`${(await box.inputValue()).trim()} ${added}`)
    await page.getByRole('button', { name: 'Save paragraph' }).click()
    await expect(page.getByLabel('Paragraph 2')).toBeHidden()
    await expect(letter).toContainText(added)
    await page.reload()
    await expect(page.getByRole('tab', { name: 'Letter' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('article', { name: 'Your cover letter' })).toContainText(added)

    await page.getByRole('button', { name: 'Copy' }).click()
    await expect(page.getByText('Copied to clipboard')).toBeVisible()
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    expect(copied).toContain(added)
    await shot(page, info, 'letter')

    // The edit is set in type again before the page shows.
    await views.getByRole('button', { name: 'Page', exact: true }).click()
    await expect(pages).toHaveAttribute('data-status', 'ready', { timeout: 90_000 })
    await expect(page.getByRole('img', { name: /Cover letter page 1 of \d+, as rendered/ })).toBeVisible()
  })

  test('cv tab: the page as LaTeX set it, its changes, and the text view', async ({ page }, info) => {
    test.setTimeout(120_000)
    await page.goto(`/applications/${f.applicationId}`)
    const pages = page.getByTestId('pdf-pages')
    await expect(pages).toHaveAttribute('data-status', 'ready', { timeout: 60_000 })
    await expect(page.getByRole('img', { name: /CV page 1 of \d+, as rendered/ })).toBeVisible()
    await expect(page.getByText(/Exactly what the recruiter gets/)).toBeVisible()
    await shot(page, info, 'cv-tab')

    // A highlight on the page opens its change.
    const highlight = pages.getByRole('button', { name: /^Open the change in / }).first()
    await expect(highlight).toBeVisible()
    await highlight.click()
    await expect(page).toHaveURL(/\?change=/)
    const sheet = page.getByRole('dialog')
    await expect(sheet.getByText('Your original')).toBeVisible()
    await shot(page, info, 'cv-change')
    await page.keyboard.press('Escape')
    await expect(sheet).toBeHidden()
    await expect(page).toHaveURL(new RegExp(`/applications/${f.applicationId}$`))

    // Read: the same CV as text, with the same marks.
    await page.getByRole('button', { name: 'Read', exact: true }).click()
    const doc = page.getByRole('article', { name: 'Your tailored CV' })
    await expect(doc).toContainText('Ada Okafor')
    await expect(doc.getByRole('link').first()).toBeVisible()
    await shot(page, info, 'cv-read')
  })

  test('download: both files or one, then mark as applied', async ({ page, baseURL }, info) => {
    test.setTimeout(120_000)
    // The reminder starts at the number of days chosen in Settings.
    const setDays = async (days: number) => {
      const res = await page.request.patch('/v1/profile', { data: { reminders: { follow_up_days: days } }, headers: { Origin: baseURL! } })
      expect(res.ok()).toBe(true)
    }
    await setDays(14)
    await page.goto(`/applications/${f.applicationId}`)
    await page.getByRole('button', { name: 'Download', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/applications/${f.applicationId}\\?download=1$`))
    const sheet = page.getByRole('dialog', { name: 'Download your files' })
    await expect(sheet).toBeVisible()
    await expect(sheet.getByText(new RegExp(`^For ${f.company}, `))).toBeVisible()
    await expect(sheet.getByText(/Your CV (has \d+ changes? for this job|is as you wrote it)/)).toBeVisible()
    await expect(sheet.getByRole('radio', { name: /PDF/ })).toBeChecked()
    const files = sheet.getByRole('list', { name: 'Files' })
    await expect(files.getByRole('listitem')).toHaveCount(2, { timeout: 60_000 })
    await expect(files).toContainText(/ CV\.pdf/)
    await expect(files).toContainText(/ Cover letter\.pdf/)
    await shot(page, info, 'download')

    await sheet.getByRole('radio', { name: /DOCX/ }).check()
    await expect(files).toContainText(/ CV\.docx/)
    await sheet.getByRole('radio', { name: /PDF/ }).check()

    const downloads: { name: string; path: Promise<string> }[] = []
    page.on('download', (d) => downloads.push({ name: d.suggestedFilename(), path: d.path() }))
    // One file on its own.
    await sheet.getByRole('button', { name: 'Download the cover letter as PDF' }).click()
    await expect.poll(() => downloads.length).toBe(1)
    expect(downloads[0]!.name).toMatch(/ Cover letter\.pdf$/)
    const ask = sheet.getByRole('region', { name: 'Did you apply?' })
    await expect(ask).toBeVisible()
    await ask.getByRole('button', { name: 'Not yet' }).click()
    await expect(ask).toBeHidden()

    // Both together.
    downloads.length = 0
    const both = sheet.getByRole('button', { name: 'Download both' })
    await expect(both).toBeEnabled()
    await both.click()
    await expect(ask).toBeVisible()
    await expect.poll(() => downloads.length).toBe(2)
    const cvPdf = downloads.find((d) => / CV\.pdf$/.test(d.name))
    expect(cvPdf).toBeTruthy()
    expect(downloads.some((d) => / Cover letter\.pdf$/.test(d.name))).toBe(true)
    expect((await readFile(await cvPdf!.path)).subarray(0, 5).toString('latin1')).toBe('%PDF-')
    await shot(page, info, 'download-ask')

    await ask.getByRole('button', { name: 'Yes, I applied' }).click()
    await expect(page.getByRole('heading', { name: 'Applied.' })).toBeVisible()
    await expect(page.getByRole('button', { name: '14 days' })).toHaveAttribute('aria-pressed', 'true')
    await setDays(7)
    const before = await page.getByText(/We will nudge you on/).textContent()
    await page.getByRole('button', { name: '10 days' }).click()
    await expect(page.getByRole('button', { name: '10 days' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByText(/We will nudge you on/)).not.toHaveText(before ?? '')
    await shot(page, info, 'applied')
    await expect(page.getByRole('link', { name: 'Back home' })).toHaveAttribute('href', '/')
    await page.getByRole('button', { name: 'Back to this application' }).click()
    await expect(page.getByRole('heading', { name: 'Applied.' })).toBeHidden()
    await expect(page).toHaveURL(new RegExp(`/applications/${f.applicationId}$`))
  })

  test('documents: master CV, filters, and the tailored files', async ({ page }, info) => {
    await page.goto('/documents')
    await expect(page.getByRole('heading', { name: 'Documents', level: 1 })).toBeVisible()
    await expect(page.getByRole('link', { name: /Master CV/ })).toBeVisible()
    const cvRow = page.getByRole('link', { name: new RegExp(`^CV · ${f.company}`) })
    const letterRow = page.getByRole('link', { name: new RegExp(`^Letter · ${f.company}`) })
    await expect(cvRow).toBeVisible()
    await expect(letterRow).toBeVisible()
    await shot(page, info, 'documents')

    await page.getByRole('tab', { name: 'Letters' }).click()
    await expect(letterRow).toBeVisible()
    await expect(cvRow).toBeHidden()
    await page.getByRole('tab', { name: 'CVs' }).click()
    await expect(cvRow).toBeVisible()
    await expect(letterRow).toBeHidden()

    const [file] = await Promise.all([
      page.waitForEvent('download', { timeout: 60_000 }),
      page.getByRole('button', { name: `Download CV · ${f.company}` }).click(),
    ])
    expect(file.suggestedFilename()).toMatch(/ CV\.pdf$/)

    await cvRow.click()
    await expect(page).toHaveURL(new RegExp(`/applications/${f.applicationId}$`))
  })
})
