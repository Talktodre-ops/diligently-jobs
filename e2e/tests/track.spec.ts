import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test'
import { createReadyAccount } from '../support/account'
import { cachedAccount, openSignedIn } from '../support/session'

// Two real pipeline runs (about $0.16) are started once and cached in
// e2e/.cache so every project and every rerun reuses them.
const CACHE = '.cache/track-seed.json'
type Seed = { email: string; password: string; ids: { applied: string; drafting: string } }

const JD_A = `Senior Backend Engineer, Payments Platform. Halcyon Health is a regulated health insurer modernising claims.
You will own the claims ledger services written in Go and Rust, run on Postgres and Kafka, and be on call for them.
Requirements: 5+ years building backend services, strong SQL and Postgres, event streaming with Kafka, experience with payment or ledger systems, clear written communication.
Nice to have: Terraform, Kubernetes, GraphQL API design. Remote within Europe and Africa time zones. You will mentor two mid-level engineers and write design docs.`
const JD_B = `Platform Engineer, Oakshore Logistics. We move freight across West Africa and need someone to run our internal platform.
You will build deployment tooling on Kubernetes and Terraform, improve observability with Prometheus and Grafana, and help teams ship Go services safely.
Requirements: 4+ years in platform or SRE roles, Kubernetes in production, Terraform, a scripting language, incident response experience.
Nice to have: Rust, Kafka, cost optimisation on AWS. Hybrid in Lagos, two days a week in the office.`

async function waitForJob(api: APIRequestContext, id: string) {
  for (let i = 0; i < 160; i++) {
    const job = await (await api.get(`/v1/jobs/${id}`)).json()
    if (job.status === 'done') return
    if (job.status === 'failed') throw new Error(`pipeline failed: ${JSON.stringify(job.progress)}`)
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error('pipeline did not finish in time')
}

async function apiFor(baseURL: string, email: string, password: string) {
  const api = await request.newContext({ baseURL, extraHTTPHeaders: { Origin: baseURL } })
  const res = await api.post('/v1/auth/signin', { data: { email, password } })
  if (!res.ok()) throw new Error(`signin ${res.status()}`)
  return api
}

async function seed(baseURL: string): Promise<Seed> {
  if (existsSync(CACHE)) {
    return JSON.parse(readFileSync(CACHE, 'utf8')) as Seed
  }
  const acct = await createReadyAccount(baseURL, { tag: 'track' })
  const api = await apiFor(baseURL, acct.email, acct.password)
  const start = async (jd: string) => {
    const res = await api.post('/v1/applications/start', { data: { jd_text: jd, research: false, letter: false } })
    if (res.status() !== 202) throw new Error(`start ${res.status()}: ${await res.text()}`)
    return (await res.json()) as { application_id: string; job_id: string }
  }
  const a = await start(JD_A)
  const b = await start(JD_B)
  await waitForJob(api, a.job_id)
  await waitForJob(api, b.job_id)
  const applied = await api.post(`/v1/applications/${a.application_id}/applied`, { data: { reminder_days: 7 } })
  expect(applied.ok()).toBe(true)
  await api.dispose()
  const out = { email: acct.email, password: acct.password, ids: { applied: a.application_id, drafting: b.application_id } }
  mkdirSync('.cache', { recursive: true })
  writeFileSync(CACHE, JSON.stringify(out))
  return out
}

let s: Seed
test.beforeAll(async ({ baseURL }) => {
  test.setTimeout(400_000)
  s = await seed(baseURL!)
})

const shot = (page: Page, name: string, project: string) => page.screenshot({ path: `shots/track/${name}-${project}.png`, fullPage: true })

test('jobs groups applications by stage and moves one between stages', async ({ page, baseURL }, info) => {
  await openSignedIn(page, s, '/jobs')
  const reset = await page.request.patch(`/v1/applications/${s.ids.drafting}/stage`, { data: { stage: 'saved' }, headers: { Origin: baseURL! } })
  expect(reset.ok()).toBe(true)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Jobs', level: 1 })).toBeVisible()
  const desktop = info.project.name === 'desktop' || info.project.name === 'wide'

  if (!desktop) await page.getByRole('tab', { name: /^Applied/ }).click()
  await expect(page.getByRole('link', { name: /Open Halcyon Health/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /Open Halcyon Health/ })).toContainText(/Senior Backend Engineer/i)
  await shot(page, 'jobs-applied', info.project.name)

  if (!desktop) await page.getByRole('tab', { name: /^Drafting/ }).click()
  const oak = page.getByRole('link', { name: /Open Oakshore/ })
  await expect(oak).toBeVisible()
  await page.getByRole('combobox', { name: /Move Oakshore/ }).selectOption('interviewing')
  if (!desktop) {
    await expect(page.getByRole('tab', { name: /^Interview 1/ })).toBeVisible()
    await page.getByRole('tab', { name: /^Interview/ }).click()
  }
  await expect(page.getByRole('tabpanel', { name: /Interview/ }).getByRole('link', { name: /Open Oakshore/ })).toBeVisible()
  await shot(page, 'jobs-interview', info.project.name)

  // The change is on the server, not just in the page.
  await page.reload()
  if (!desktop) await page.getByRole('tab', { name: /^Interview/ }).click()
  await expect(page.getByRole('tabpanel', { name: /Interview/ }).getByRole('link', { name: /Open Oakshore/ })).toBeVisible()

  await page.getByRole('link', { name: /Open Oakshore/ }).click()
  await expect(page).toHaveURL(new RegExp(`/applications/${s.ids.drafting}$`))
})

test('a new user sees an empty Jobs screen with a way to start', async ({ page, baseURL }, info) => {
  const acct = await cachedAccount('main', () => createReadyAccount(baseURL!, { tag: 'account' }))
  await openSignedIn(page, acct, '/jobs')
  await expect(page.getByText('No jobs yet')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Start your first job' })).toHaveAttribute('href', '/new')
  await shot(page, 'jobs-empty', info.project.name)
})

test('follow-up drafts a message signed with the real name, copies it, snoozes and finishes', async ({ page, baseURL, context }, info) => {
  test.setTimeout(120_000)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await openSignedIn(page, s, `/applications/${s.ids.applied}/follow-up`)
  const box = page.getByLabel('Message')
  await expect(box).not.toHaveValue('', { timeout: 60_000 })
  const email = await box.inputValue()
  expect(email).toContain('Ada Okafor')
  await shot(page, 'follow-up-email', info.project.name)

  await page.getByRole('tab', { name: 'LinkedIn' }).click()
  await expect(box).not.toHaveValue(email, { timeout: 60_000 })
  await expect(page.getByText(/of 300 characters/)).toBeVisible()
  await shot(page, 'follow-up-linkedin', info.project.name)

  await box.fill('Hi team, a quick check-in on my application. Ada Okafor')
  await page.getByRole('button', { name: /^Copy/ }).click()
  await expect(page.getByText(/Copied\. Paste it in LinkedIn/)).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Hi team, a quick check-in on my application. Ada Okafor')

  await page.getByRole('button', { name: /remind me in 3 days/ }).click()
  await expect(page.getByText(/Reminder set for/)).toBeVisible()

  await page.getByRole('button', { name: /mark as followed up/ }).click()
  await expect(page.getByRole('heading', { name: 'Followed up' })).toBeVisible()
  await shot(page, 'follow-up-done', info.project.name)

  // Reopening shows the done state because the reminder is done on the server.
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Followed up' })).toBeVisible()
  // Put the reminder back so a rerun starts from the same state.
  const again = await page.request.post(`/v1/applications/${s.ids.applied}/applied`, { data: { reminder_days: 7 }, headers: { Origin: baseURL! } })
  expect(again.ok()).toBe(true)
})
