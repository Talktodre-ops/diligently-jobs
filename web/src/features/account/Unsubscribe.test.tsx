import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import UnsubscribePage from './UnsubscribePage'

type Call = { url: string; method: string; body?: string; headers?: HeadersInit }

function setup(path: string, reply: (url: string) => Response) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined, headers: init?.headers })
    return reply(url)
  }))
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes><Route path="/unsubscribe" element={<UnsubscribePage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return calls
}

const ok = () => new Response(JSON.stringify({ kind: 'weekly_summary', email: 'ad***@gmail.com' }), { status: 200 })
const err = (status: number, code: string) => new Response(JSON.stringify({ error: { code, message: 'nope' } }), { status })

afterEach(() => vi.unstubAllGlobals())

describe('UnsubscribePage', () => {
  it('turns the email off on load and Undo turns it back on', async () => {
    const calls = setup('/unsubscribe?token=tok123&kind=weekly_summary', ok)
    expect(await screen.findByRole('heading', { name: 'No more Monday summaries.' })).toBeInTheDocument()
    expect(screen.getByText(/Done for ad\*\*\*@gmail\.com\. Follow-up reminders and everything else stay as they were\./)).toBeInTheDocument()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ url: '/v1/email/unsubscribe', method: 'POST', body: '{"token":"tok123","kind":"weekly_summary"}' })

    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(await screen.findByRole('heading', { name: 'Monday summaries are back on.' })).toBeInTheDocument()
    expect(calls[1]).toMatchObject({ url: '/v1/email/resubscribe', method: 'POST', body: '{"token":"tok123","kind":"weekly_summary"}' })
    expect(screen.getByRole('link', { name: 'open Settings' })).toHaveAttribute('href', '/settings')
  })

  it('says so when the token is unknown', async () => {
    setup('/unsubscribe?token=gone&kind=follow_ups', () => err(404, 'not_found'))
    expect(await screen.findByRole('heading', { name: 'We do not recognise this link.' })).toBeInTheDocument()
  })

  it('does not call the API for a kind it does not know', async () => {
    const calls = setup('/unsubscribe?token=tok&kind=interview_prep', ok)
    expect(await screen.findByRole('heading', { name: 'This link is not complete.' })).toBeInTheDocument()
    expect(calls).toHaveLength(0)
  })

  it('does not call the API without a token', async () => {
    const calls = setup('/unsubscribe?kind=product_news', ok)
    expect(await screen.findByRole('heading', { name: 'This link is not complete.' })).toBeInTheDocument()
    expect(calls).toHaveLength(0)
  })

  it('treats a 400 from the API as a broken link', async () => {
    setup('/unsubscribe?token=tok&kind=product_news', () => err(400, 'validation'))
    expect(await screen.findByRole('heading', { name: 'This link is not complete.' })).toBeInTheDocument()
  })

  it('offers a retry when the API is busy', async () => {
    let n = 0
    setup('/unsubscribe?token=tok&kind=running_low', () => (++n === 1 ? err(429, 'rate_limited') : ok()))
    expect(await screen.findByRole('heading', { name: 'That did not go through.' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { name: 'No more running low emails.' })).toBeInTheDocument()
  })

  it('keeps the page and shows why when Undo fails', async () => {
    let n = 0
    setup('/unsubscribe?token=tok&kind=weekly_summary', () => (++n === 1 ? ok() : err(500, 'internal')))
    await userEvent.click(await screen.findByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('nope'))
    expect(screen.getByRole('heading', { name: 'No more Monday summaries.' })).toBeInTheDocument()
  })
})
