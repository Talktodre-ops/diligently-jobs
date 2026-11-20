import { expect, test, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReadyAccount } from '../support/account'
import { openSignedIn } from '../support/session'

// The apply flow: Home, New job, Running, Workspace, Review, Gaps.
// The end-to-end test runs the real pipeline (real AI, about $0.08), so it
// runs once, in the mobile project, and resizes the page for desktop shots.

const SHOTS = 'shots/apply'
const MOBILE = { width: 390, height: 844 }
const DESKTOP = { width: 1440, height: 900 }

// A realistic posting for a fictional company. Long enough to pass the 200
// character minimum with room to spare, and close enough to the sample CV
// from createReadyAccount that the pipeline has real rewrites to propose.
const JOB_DESCRIPTION = `Senior Backend Engineer, Payments Platform
Cobalt Harbor (fully remote, EMEA time zones)

About us
Cobalt Harbor builds the payments and settlement layer for mid-sized freight carriers. Our platform moves money between shippers, carriers and fuel networks, and reconciles every cent against bank statements each day. We are a Series A company of 38 people, 14 of them engineers.

The role
You will join the Payments Platform team of five engineers and own services that settle around 2 million transactions a month. You will design APIs, model money correctly in Postgres, and keep our event pipeline on Kafka healthy as volume grows.

What you will do
- Design and build backend services in Go that handle payouts, refunds and ledger entries.
- Own the reconciliation pipeline that matches our ledger against bank and card network files.
- Improve reliability: define SLOs, lead incident reviews and take part in a weekly on-call rotation.
- Work with product and finance to turn messy settlement rules into clear, tested code.
- Mentor two mid-level engineers through design reviews and pairing.

What we are looking for
- 5+ years building backend systems, with at least 2 in payments, banking or another domain where money must add up.
- Strong Go, or strong Rust with a willingness to write Go every day.
- Deep Postgres knowledge: schema design, partitioning, query tuning and safe migrations.
- Production experience with Kafka or a similar event streaming system.
- Experience running services on Kubernetes and managing infrastructure with Terraform.
- Clear written communication; we write design docs before we write code.

Nice to have
- Experience with PCI DSS scope reduction or SOC 2 audits.
- GraphQL API design.
- Familiarity with ISO 20022 or SEPA payment formats.

What we offer
Salary of EUR 85,000 to 105,000, equity, a home office budget, and four weeks of paid leave plus public holidays.`

/**
 * One account per tag per run (the e2e container's /tmp lives for one run),
 * signed in through the real /signin form once; later projects reuse its
 * cookies through support/session.ts.
 */
async function signedIn(page: Page, baseURL: string, tag: string, path = '/') {
  const file = join(tmpdir(), `apply-${tag}.json`)
  let acct: { email: string; password: string }
  if (existsSync(file)) {
    acct = JSON.parse(await readFile(file, 'utf8'))
  } else {
    acct = await createReadyAccount(baseURL, { tag })
    await writeFile(file, JSON.stringify(acct))
  }
  await openSignedIn(page, acct, path)
}

async function shot(page: Page, name: string, project: string) {
  await page.screenshot({ path: `${SHOTS}/${name}-${project}.png`, fullPage: true })
}

/** Screenshot the current page at phone and desktop width, then go back to the phone. */
async function bothSizes(page: Page, name: string) {
  await page.setViewportSize(MOBILE)
  await page.waitForLoadState('networkidle')
  await shot(page, name, 'mobile')
  // The desktop layout is a different tree that fetches its own data.
  await page.setViewportSize(DESKTOP)
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(300)
  await shot(page, name, 'desktop')
  await page.setViewportSize(MOBILE)
}

test('a new user sees a useful Home with a clear first step', async ({ page, baseURL }, info) => {
  // The validation test below shares this account; it never starts a job.
  await signedIn(page, baseURL!, 'apply-fresh')
  await expect(page.getByRole('heading', { level: 1, name: /(Morning|Afternoon|Evening), Ada\./ })).toBeVisible()
  await expect(page.getByText('Paste a job you want and we will tailor your CV to it.')).toBeVisible()
  await expect(page.getByText(/Nothing yet this week/)).toBeVisible()
  // A ready account has a CV, a check and targets: one setup step is left.
  const setup = page.getByRole('region', { name: 'Get set up' })
  await expect(setup.getByText('3 of 4 done')).toBeVisible()
  await expect(setup.getByRole('link', { name: /Tailor your first CV/ })).toHaveAttribute('href', '/new')
  if (info.project.name === 'mobile' || info.project.name === 'tablet') {
    await expect(page.getByRole('link', { name: 'New application' })).toBeVisible()
  } else {
    await expect(page.getByLabel('Job link or description')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Pipeline' })).toBeVisible()
  }
  await shot(page, 'home-empty', info.project.name)
})

test('New job checks the input before spending anything', async ({ page, baseURL }, info) => {
  await signedIn(page, baseURL!, 'apply-fresh', '/new')
  await expect(page.getByRole('heading', { name: 'Found a job?' })).toBeVisible()

  await page.getByRole('button', { name: 'Tailor my CV' }).click()
  await expect(page.getByText('Paste the job description first.')).toBeVisible()

  await page.getByLabel('Job description').fill('Backend engineer, Go, Postgres.')
  await page.getByRole('button', { name: 'Tailor my CV' }).click()
  await expect(page.getByText(/looks short for a job description/)).toBeVisible()

  await page.getByRole('tab', { name: 'Job link' }).click()
  await page.getByLabel('Link to the job').fill('not a link')
  await page.getByRole('button', { name: 'Tailor my CV' }).click()
  await expect(page.getByText('Paste a full link starting with https://')).toBeVisible()

  const research = page.getByRole('switch', { name: 'Research the company' })
  await expect(research).toHaveAttribute('aria-checked', 'true')
  await research.click()
  await expect(research).toHaveAttribute('aria-checked', 'false')

  await page.getByRole('tab', { name: 'Paste text' }).click()
  await page.getByLabel('Job description').fill(JOB_DESCRIPTION.slice(0, 600))
  await shot(page, 'newjob', info.project.name)

  // Nothing above reached the API: the month's count is still zero.
  const usage = await page.request.get('/v1/usage')
  expect((await usage.json()).applications_this_month).toBe(0)
})

test('apply end to end: paste a job, watch it run, review, answer a gap', async ({ page, baseURL }, info) => {
  test.skip(info.project.name !== 'mobile', 'Runs the real pipeline once; desktop shots come from resizing.')
  test.setTimeout(10 * 60_000)

  await signedIn(page, baseURL!, 'apply-e2e')

  // Home to New job through the floating button.
  await page.getByRole('link', { name: 'New application' }).click()
  await expect(page).toHaveURL(/\/new$/)
  await page.getByLabel('Job description').fill(JOB_DESCRIPTION)
  await bothSizes(page, 'newjob-filled')
  await page.getByRole('button', { name: 'Tailor my CV' }).click()

  // Tailoring shows in place on the application, and survives a reload.
  await expect(page).toHaveURL(/\/applications\/[0-9a-f-]+$/)
  const appUrl = page.url()
  const steps = page.getByRole('list', { name: 'Progress' })
  await expect(steps.getByRole('listitem')).toHaveCount(5)
  await expect(page.getByRole('heading', { name: 'Tailoring your CV' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Download', exact: true })).toBeDisabled()
  await bothSizes(page, 'running')
  await page.reload()
  const score = page.getByRole('region', { name: 'Match score' })
  await expect(steps.or(score)).toBeVisible()

  // When it finishes, the page as LaTeX set it takes its place, each change highlighted.
  await expect(score).toBeVisible({ timeout: 6 * 60_000 })
  await expect(page.getByRole('heading', { name: 'Tailoring your CV' })).toBeHidden()
  const pages = page.getByTestId('pdf-pages')
  await expect(pages).toHaveAttribute('data-status', 'ready', { timeout: 90_000 })
  await expect(pages.getByRole('button', { name: /^Open the change in / }).first()).toBeVisible()
  await expect(page.getByText('Cobalt Harbor', { exact: false }).first()).toBeVisible()
  const nowBefore = Number(await score.getByRole('status').textContent())
  const notSeen = page.getByRole('button', { name: /^\d+ not looked at yet$/ })
  await expect(notSeen).toBeVisible()
  const waitingBefore = Number((await notSeen.textContent())!.match(/^(\d+)/)![1])
  expect(waitingBefore).toBeGreaterThan(1)
  await bothSizes(page, 'workspace')

  // Look over: keep one as suggested, edit the next; two fewer not looked at.
  await notSeen.click()
  await expect(page).toHaveURL(`${appUrl}?change=next`)
  const sheet = page.getByRole('dialog')
  await expect(sheet.getByText('In your CV for this job')).toBeVisible()
  await bothSizes(page, 'review')
  await sheet.getByRole('button', { name: 'Looks good' }).click()
  await sheet.getByRole('button', { name: 'Edit', exact: true }).click()
  const edit = sheet.getByRole('textbox', { name: 'Edit the line' })
  await edit.fill('Owned Go services for payment reconciliation, matching ledger entries against bank files every day.')
  await bothSizes(page, 'review-edit')
  await sheet.getByRole('button', { name: 'Save and use' }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeHidden()
  const left = waitingBefore - 2
  if (left > 0) await expect(page.getByRole('button', { name: `${left} not looked at yet` })).toBeVisible()
  else await expect(page.getByRole('button', { name: /not looked at yet/ })).toBeHidden()
  // The page is set in type again with the edit; Read shows the text.
  await expect(pages).toHaveAttribute('data-status', 'ready', { timeout: 90_000 })
  await page.getByRole('button', { name: 'Read', exact: true }).click()
  const cv = page.getByRole('article', { name: 'Your tailored CV' })
  await expect(cv).toContainText('Owned Go services for payment reconciliation')
  // Both were in the CV already, so the score holds.
  const nowAfter = Number(await score.getByRole('status').textContent())
  expect(nowAfter).toBeGreaterThanOrEqual(nowBefore)

  // Questions above the CV: answer one with "I have this" (a real AI call), add the bullet, then "I don't".
  const questions = page.getByRole('heading', { name: /questions? would make this stronger/ })
  if (await questions.isVisible()) {
    await bothSizes(page, 'gaps')
    await page.getByRole('button', { name: 'I have this' }).click()
    await page.getByLabel('Where did you use it?').fill(
      'At Northfold I wrote a design doc for every ledger change and ran zero-downtime Postgres migrations with expand and contract steps.',
    )
    await page.getByRole('button', { name: 'Write a bullet' }).click()
    const suggestion = page.getByText('Suggested bullet')
    const noBullet = page.getByText(/does not show the requirement yet/)
    await expect(suggestion.or(noBullet)).toBeVisible({ timeout: 90_000 })
    if (await suggestion.isVisible()) {
      await bothSizes(page, 'gaps-suggested')
      await page.getByRole('button', { name: 'Add to this CV' }).click()
      await expect(suggestion).toBeHidden()
    }
    const dont = page.getByRole('button', { name: "I don't" })
    if (await dont.isVisible()) {
      await dont.click()
      await expect(page.getByRole('button', { name: "I don't" }).or(page.getByRole('heading', { name: /You answered/ })).first()).toBeVisible()
    }
    await bothSizes(page, 'gaps-answered')
  }

  // Desktop: every change listed beside the rendered CV.
  await page.setViewportSize(DESKTOP)
  await expect(page.getByRole('heading', { name: /changes? in your CV|No changes suggested/ })).toBeVisible()
  await expect(page.getByRole('switch', { name: 'Show changes' })).toBeVisible()
  await expect(cv).toContainText('Owned Go services for payment reconciliation')
  await shot(page, 'workspace-after', 'desktop')
  await page.setViewportSize(MOBILE)
  await shot(page, 'workspace-after', 'mobile')

  // Home now has the application: an unfinished card and a timeline entry.
  await page.goto('/')
  // The account is reused between runs, so earlier runs can leave entries too: the newest comes first.
  await expect(page.getByText(/Tailored your CV for Cobalt Harbor/).first()).toBeVisible()
  await expect(page.getByText('Unfinished').first()).toBeVisible()
  await bothSizes(page, 'home')
})
