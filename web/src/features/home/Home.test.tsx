import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiError, json, renderRoute, type Call } from '../apply/testing'
import type { HomeData } from './api'
import HomePage from './HomePage'

afterEach(() => vi.unstubAllGlobals())

const emptyHome: HomeData = { first_name: 'Ada', needs_you: [], this_week: [], stats: { applied_this_week: 0, active: 0, interviewing: 0 } }
const busyHome: HomeData = {
  first_name: 'Ada',
  needs_you: [
    { type: 'follow_up', application_id: 'a1', reminder_id: 'r1', company: 'Halcyon Health', role: 'Backend Engineer', due_at: new Date().toISOString(), text: 'Follow up with Halcyon Health' },
    { type: 'review', application_id: 'a2', company: 'Ledgerline', role: 'Product Engineer', pending: 3, text: 'Review 3 rewrites for Ledgerline' },
    { type: 'retry', application_id: 'a3', company: null, role: null, text: 'Finish tailoring for this job' },
  ],
  this_week: [{ at: new Date().toISOString(), kind: 'pipeline_done', application_id: 'a2', company: 'Ledgerline', role: 'Product Engineer', text: 'Tailored your CV for Ledgerline' }],
  stats: { applied_this_week: 1, active: 2, interviewing: 0 },
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
})
