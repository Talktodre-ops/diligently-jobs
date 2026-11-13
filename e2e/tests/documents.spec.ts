import { expect, request, test, type Browser, type Page, type TestInfo } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createReadyAccount } from '../support/account'

// Research, Cover letter, CV preview, Send and Documents, driven the way a
// person would after a real pipeline has finished.
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

const isWide = (info: TestInfo) => info.project.name === 'desktop' || info.project.name === 'wide'

let f: Fixture

test.describe.serial('documents', () => {
  test.beforeAll(async ({ browser, baseURL }, info) => {
    test.setTimeout(600_000)
    f = await signInOnce(browser, baseURL!, info)
  })

  test.use({ storageState: async ({}, use, info) => use(sessionFile(info)) })

  test('research reads as overview, talking points and sources', async ({ page }, info) => {
    await page.goto(`/applications/${f.applicationId}/research`)
    await expect(page.getByRole('heading', { level: 1 }).last()).toBeVisible()
    await expect(page.getByText(/From \d+ web sources?, gathered/)).toBeVisible()
    await shot(page, info, 'research')
    if (isWide(info)) {
      await expect(page.getByRole('heading', { name: 'Talking points' })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Sources' })).toBeVisible()
    } else {
      await page.getByRole('tab', { name: 'Talking points' }).click()
      await expect(page.getByRole('tab', { name: 'Talking points' })).toHaveAttribute('aria-selected', 'true')
      await shot(page, info, 'research-points')
      await page.getByRole('tab', { name: 'Sources' }).click()
    }
    const firstSource = page.getByRole('tabpanel').or(page.locator('section', { has: page.getByRole('heading', { name: 'Sources' }) })).getByRole('link').first()
    await expect(firstSource).toHaveAttribute('target', '_blank')
    await expect(firstSource).toHaveAttribute('href', /^https?:\/\//)
    await expect(page.getByRole('link', { name: 'Back to application' })).toHaveAttribute('href', `/applications/${f.applicationId}`)
  })

  test('cover letter: switch tone, edit a paragraph, copy', async ({ page, context }, info) => {
    test.setTimeout(120_000)
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.goto(`/applications/${f.applicationId}/letter`)
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
    await expect(page.getByRole('article', { name: 'Your cover letter' })).toContainText(added)

    await page.getByRole('button', { name: 'Copy' }).click()
    await expect(page.getByText('Copied to clipboard')).toBeVisible()
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    expect(copied).toContain(added)
    await shot(page, info, 'letter')

    await page.getByRole('button', { name: 'Use this letter' }).click()
    await expect(page).toHaveURL(new RegExp(`/applications/${f.applicationId}$`))
  })

  test('cv preview: page and read views, download the PDF', async ({ page }, info) => {
    test.setTimeout(120_000)
    await page.goto(`/applications/${f.applicationId}/cv`)
    const pages = page.getByTestId('pdf-pages')
    await expect(pages).toHaveAttribute('data-status', 'ready', { timeout: 60_000 })
    await expect(page.getByRole('img', { name: /CV page 1 of \d+, as rendered/ })).toBeVisible()
    await shot(page, info, 'cv-page')

    await page.getByRole('button', { name: 'Read', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Read', exact: true })).toHaveAttribute('aria-pressed', 'true')
    const doc = page.getByRole('article', { name: 'Your tailored CV' })
    await expect(doc).toContainText('Ada Okafor')
    await expect(doc.locator('mark').first()).toBeVisible()
    await expect(page.getByText(/\d+ changes? highlighted/)).toBeVisible()
    await shot(page, info, 'cv-read')

    if (!isWide(info)) {
      await page.getByRole('button', { name: 'Download PDF or DOCX' }).click()
      await expect(page.getByRole('dialog', { name: 'Download your CV' })).toBeVisible()
      await shot(page, info, 'cv-download')
    }
    const [pdf] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download PDF', exact: true }).click()])
    expect(pdf.suggestedFilename()).toMatch(/^Ada Okafor .+ CV\.pdf$/)
    const path = await pdf.path()
    expect((await readFile(path)).subarray(0, 5).toString('latin1')).toBe('%PDF-')

    if (isWide(info)) {
      const [docx] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download DOCX', exact: true }).click()])
      expect(docx.suggestedFilename()).toMatch(/ CV\.docx$/)
      expect((await readFile(await docx.path())).subarray(0, 2).toString('latin1')).toBe('PK')
    }
  })

  test('send: choose files, hand them over, mark as applied', async ({ page }, info) => {
    test.setTimeout(120_000)
    await page.goto(`/applications/${f.applicationId}/cv`)
    await page.getByRole('link', { name: 'Send CV' }).click()
    await expect(page).toHaveURL(new RegExp(`/applications/${f.applicationId}/send$`))
    await expect(page.getByRole('heading', { name: 'How should it go out?' })).toBeVisible()
    await expect(page.getByRole('radio', { name: /PDF/ })).toBeChecked()
    await expect(page.getByRole('switch', { name: 'Include cover letter' })).toHaveAttribute('aria-checked', 'true')
    const files = page.getByRole('list', { name: 'Files' })
    await expect(files.getByRole('listitem')).toHaveCount(2, { timeout: 60_000 })
    await expect(files).toContainText(/ CV\.pdf/)
    await expect(files).toContainText(/ Cover letter\.pdf/)
    await shot(page, info, 'send')

    await page.getByRole('radio', { name: /DOCX/ }).check()
    await expect(files).toContainText(/ CV\.docx/)
    await page.getByRole('radio', { name: /PDF/ }).check()

    const handOver = page.getByRole('button', { name: /^(Share|Download files)$/ })
    await expect(handOver).toBeEnabled()
    const downloads: string[] = []
    page.on('download', (d) => downloads.push(d.suggestedFilename()))
    await handOver.click()
    const dialog = page.getByRole('dialog', { name: 'Did you send it?' })
    await expect(dialog).toBeVisible()
    await expect.poll(() => downloads.length).toBe(2)
    expect(downloads.some((n) => / CV\.pdf$/.test(n))).toBe(true)
    expect(downloads.some((n) => / Cover letter\.pdf$/.test(n))).toBe(true)
    await shot(page, info, 'send-confirm')

    await dialog.getByRole('button', { name: 'Yes, mark as applied' }).click()
    await expect(page.getByRole('heading', { name: 'Applied.' })).toBeVisible()
    await expect(page.getByRole('button', { name: '7 days' })).toHaveAttribute('aria-pressed', 'true')
    const before = await page.getByText(/We will nudge you on/).textContent()
    await page.getByRole('button', { name: '10 days' }).click()
    await expect(page.getByRole('button', { name: '10 days' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByText(/We will nudge you on/)).not.toHaveText(before ?? '')
    await shot(page, info, 'send-done')
    await expect(page.getByRole('link', { name: 'Back home' })).toHaveAttribute('href', '/')
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
      page.getByRole('button', { name: `Share CV · ${f.company}` }).click(),
    ])
    expect(file.suggestedFilename()).toMatch(/ CV\.pdf$/)

    await cvRow.click()
    await expect(page).toHaveURL(new RegExp(`/applications/${f.applicationId}/cv$`))
  })
})
