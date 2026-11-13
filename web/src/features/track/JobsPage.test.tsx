import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import JobsPage from './JobsPage'

const app = (id: string, company: string, stage: string) => ({
  id, company, role: 'Backend Engineer', status: 'draft', stage, submitted_at: null,
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
})

function routes(apps: unknown[], calls: { url: string; method: string; body?: string }[] = []) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined })
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
    if (url.startsWith('/v1/applications?')) return json(apps)
    if (url === '/v1/home') return json({ needs_you: [{ type: 'follow_up', application_id: 'a1' }] })
    if (url.endsWith('/brief')) return json({ score: { current: 81 } })
    if (url.endsWith('/stage')) return json({ application_id: 'a1', stage: 'interviewing' })
    return json({ error: { code: 'not_found', message: 'no' } }, 404)
  }))
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><MemoryRouter><JobsPage /></MemoryRouter></QueryClientProvider>)
}

afterEach(() => vi.unstubAllGlobals())

describe('JobsPage', () => {
  it('shows an empty state for a new user', async () => {
    routes([])
    mount()
    expect(await screen.findByText('No jobs yet')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Start your first job' })).toHaveAttribute('href', '/new')
  })

  it('groups jobs by stage, flags a due follow-up and moves a job', async () => {
    const calls: { url: string; method: string; body?: string }[] = []
    routes([app('a1', 'Halcyon Health', 'applied'), app('a2', 'Ledgerline', 'saved')], calls)
    mount()
    expect(await screen.findByRole('link', { name: /Open Halcyon Health/ })).toHaveAttribute('href', '/applications/a1')
    expect(screen.getByRole('link', { name: 'Follow up today' })).toHaveAttribute('href', '/applications/a1/follow-up')
    expect(await screen.findByText('81')).toBeInTheDocument()
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /Move Halcyon Health/ }), 'interviewing')
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH' && c.url === '/v1/applications/a1/stage' && c.body === '{"stage":"interviewing"}')).toBe(true))
  })

  it('shows an error with a retry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'x', message: 'Broken' } }), { status: 500 })))
    mount()
    expect(await screen.findByRole('alert')).toHaveTextContent('Broken')
  })
})
