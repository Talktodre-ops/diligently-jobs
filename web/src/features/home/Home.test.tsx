import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiError, json, renderRoute, type Call } from '../apply/testing'
import type { HomeData } from './api'
import HomePage from './HomePage'

afterEach(() => vi.unstubAllGlobals())

const allSet = { cv: true, check: true, targets: true, first_application: true, hidden_until: null, show: false }
const emptyHome: HomeData = { first_name: 'Ada', needs_you: [], this_week: [], stats: { applied_this_week: 0, active: 0, interviewing: 0 }, setup: allSet }
const newHome: HomeData = {
  ...emptyHome,
  setup: { cv: true, check: false, targets: false, first_application: false, hidden_until: null, show: true },
}
const busyHome: HomeData = {
  first_name: 'Ada',
  needs_you: [
    { type: 'follow_up', application_id: 'a1', reminder_id: 'r1', company: 'Halcyon Health', role: 'Backend Engineer', due_at: new Date().toISOString(), text: 'Follow up with Halcyon Health' },
    { type: 'review', application_id: 'a2', company: 'Ledgerline', role: 'Product Engineer', pending: 3, text: 'Review 3 rewrites for Ledgerline' },
    { type: 'retry', application_id: 'a3', company: null, role: null, text: 'Finish tailoring for this job' },
  ],
  this_week: [{ at: new Date().toISOString(), kind: 'pipeline_done', application_id: 'a2', company: 'Ledgerline', role: 'Product Engineer', text: 'Tailored your CV for Ledgerline' }],
  stats: { applied_this_week: 1, active: 2, interviewing: 0 },
  setup: allSet,
}
const apps = [
  { id: 'a2', company: 'Ledgerline', role: 'Product Engineer', status: 'draft', stage: 'saved', created_at: '', updated_at: '' },
  { id: 'a1', company: 'Halcyon Health', role: 'Backend Engineer', status: 'draft', stage: 'applied', created_at: '', updated_at: '' },
]

function open(home: HomeData | Response, list: unknown[] = [], extra: (c: Call) => Response | undefined = () => undefined) {
  return renderRoute(<HomePage />, {
    path: '/', pattern: '/',
    api: (c) => {
      if (c.url === '/v1/home') return home instanceof Response ? home : json(home)
      if (c.url.startsWith('/v1/applications?')) return json(list)
      if (c.url === '/v1/profile') return json({ profile: { full_name: 'Ada Okafor' } })
      return extra(c)
    },
  })
}

function desktop(on: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: on && q.includes('min-width'), media: q, addEventListener() {}, removeEventListener() {} }))
}

describe('HomePage', () => {
  it('greets a new user and points at the first job', async () => {
    open(emptyHome)
    expect(await screen.findByRole('heading', { level: 1, name: /, Ada\.$/ })).toBeInTheDocument()
    expect(await screen.findByText('Your first application')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Start with a job' })).toHaveAttribute('href', '/new')
    expect(screen.getByRole('link', { name: 'New application' })).toHaveAttribute('href', '/new')
    expect(screen.getByText(/Nothing yet this week/)).toBeInTheDocument()
  })

  it('shows what needs the user, each card leading somewhere useful', async () => {
    open(busyHome, apps)
    expect(await screen.findByText('Three things need you today.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Draft follow-up' })).toHaveAttribute('href', '/applications/a1/follow-up')
    expect(screen.getByRole('link', { name: /Unfinished.*Ledgerline · Product Engineer.*3 rewrites left to review/ })).toHaveAttribute('href', '/applications/a2')
    expect(screen.getByRole('link', { name: /Stopped.*New job/ })).toHaveAttribute('href', '/applications/a3/running')
    const week = screen.getByRole('region', { name: 'This week' })
    expect(within(week).getByRole('link', { name: /Tailored your CV for Ledgerline/ })).toHaveAttribute('href', '/applications/a2')
  })

  it('lists the setup steps that are left, each opening its screen', async () => {
    open(newHome)
    const card = await screen.findByRole('region', { name: 'Get set up' })
    expect(within(card).getByText('1 of 4 done')).toBeInTheDocument()
    expect(within(card).queryByRole('link', { name: /Add your CV/ })).not.toBeInTheDocument()
    expect(within(card).getByText(/Add your CV/)).toBeInTheDocument()
    expect(within(card).getByRole('link', { name: /Check what we read/ })).toHaveAttribute('href', '/onboarding/check')
    expect(within(card).getByRole('link', { name: /Say what you want/ })).toHaveAttribute('href', '/onboarding/targets')
    expect(within(card).getByRole('link', { name: /Tailor your first CV/ })).toHaveAttribute('href', '/new')
    // The card already offers the first job, so the empty-state card stays away.
    expect(screen.queryByText('Your first application')).not.toBeInTheDocument()
  })

  it('keeps steps that need a CV closed until there is one', async () => {
    open({ ...newHome, setup: { ...newHome.setup, cv: false } })
    const card = await screen.findByRole('region', { name: 'Get set up' })
    expect(within(card).getByRole('link', { name: /Add your CV/ })).toHaveAttribute('href', '/onboarding/upload')
    expect(within(card).queryByRole('link', { name: /Check what we read/ })).not.toBeInTheDocument()
    expect(within(card).queryByRole('link', { name: /Tailor your first CV/ })).not.toBeInTheDocument()
    expect(within(card).getAllByText('After you add your CV.')).toHaveLength(2)
  })

  it('hides the setup card through the API, so it stays hidden everywhere', async () => {
    let hidden = false
    const calls = renderRoute(<HomePage />, {
      path: '/', pattern: '/',
      api: (c) => {
        if (c.method === 'POST' && c.url === '/v1/setup/hide') {
          hidden = true
          return new Response(null, { status: 204 })
        }
        if (c.url === '/v1/home') return json(hidden ? { ...newHome, setup: { ...newHome.setup, show: false, hidden_until: '2026-11-25T09:00:00Z' } } : newHome)
        if (c.url.startsWith('/v1/applications?')) return json([])
        if (c.url === '/v1/profile') return json({ profile: { full_name: 'Ada Okafor' } })
        return undefined
      },
    })
    const card = await screen.findByRole('region', { name: 'Get set up' })
    await userEvent.click(within(card).getByRole('button', { name: 'Hide' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Get set up' })).not.toBeInTheDocument())
    expect(hidden).toBe(true)
    expect(calls.filter((c) => c.url === '/v1/setup/hide')).toHaveLength(1)
  })

  it('shows no setup card when the server says so', async () => {
    open(busyHome, apps)
    await screen.findByText('Three things need you today.')
    expect(screen.queryByRole('region', { name: 'Get set up' })).not.toBeInTheDocument()
  })

  it('shows an error with a retry when Home does not load', async () => {
    open(apiError(503, 'ai_unavailable', 'Back in a moment.'))
    expect(await screen.findByText('Back in a moment.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('on desktop, starts a job from the composer and shows the pipeline', async () => {
    desktop(true)
    const calls = open(busyHome, apps, (c) =>
      c.method === 'POST' && c.url === '/v1/applications/start' ? json({ application_id: 'new1', job_id: 'j9', progress: [] }, 202) : undefined,
    )
    const pipeline = await screen.findByRole('region', { name: 'Pipeline' })
    expect(within(pipeline).getByRole('link', { name: /Ledgerline/ })).toHaveAttribute('href', '/applications/a2')
    expect(within(pipeline).getByRole('link', { name: /Halcyon Health.*Follow up today/ })).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText('Job link or description'), 'https://jobs.example.com/42')
    await userEvent.click(screen.getByRole('button', { name: /Tailor my CV/ }))
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/applications/new1/running'))
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ url: 'https://jobs.example.com/42', research: true, letter: true })
  })

  it('folds a long week after six items and expands in place', async () => {
    const week = Array.from({ length: 9 }, (_, n) => ({
      at: new Date(Date.now() - n * 3600_000).toISOString(), kind: 'pipeline_done', application_id: `a${n}`,
      company: 'Ledgerline', role: 'Product Engineer', text: `Tailored your CV, job ${n + 1}`,
    }))
    open({ ...busyHome, this_week: week }, apps)
    const region = await screen.findByRole('region', { name: 'This week' })
    expect(within(region).getAllByRole('listitem')).toHaveLength(6)
    const more = within(region).getByRole('button', { name: 'See all 9' })
    expect(more).toHaveAttribute('aria-expanded', 'false')

    await userEvent.click(more)
    expect(within(region).getAllByRole('listitem')).toHaveLength(9)
    expect(within(region).getByText('Tailored your CV, job 9')).toBeInTheDocument()
    expect(within(region).getByRole('button', { name: 'Show fewer' })).toHaveAttribute('aria-expanded', 'true')

    await userEvent.click(within(region).getByRole('button', { name: 'Show fewer' }))
    expect(within(region).getAllByRole('listitem')).toHaveLength(6)
  })

  it('shows no See all control for six items or fewer', async () => {
    open(busyHome, apps)
    const region = await screen.findByRole('region', { name: 'This week' })
    expect(within(region).queryByRole('button')).not.toBeInTheDocument()
  })
})
