import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import FollowUpPage from './FollowUpPage'

const draft = { id: 'd1', channel: 'email', subject: 'Senior Backend Engineer application', body: 'Hi {name},\n\nChecking in.\n\nAda Okafor', created_at: '' }
const reminder = { id: 'r1', application_id: 'a1', due_at: new Date().toISOString(), status: 'scheduled', sent_at: null }

function setup(drafts: unknown) {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
    if (url === '/v1/applications/a1') return json({ id: 'a1', company: 'Halcyon Health', role: 'X', stage: 'applied', submitted_at: new Date().toISOString() })
    if (url === '/v1/applications/a1/follow-ups' && init?.method !== 'POST') return json({ drafts, reminder })
    if (url === '/v1/applications/a1/follow-ups') return json({ draft })
    if (url === '/v1/reminders/r1/done') return json({ reminder: { ...reminder, status: 'done' } })
    if (url === '/v1/reminders/r1/snooze') return json({ reminder })
    return new Response('{}', { status: 404 })
  }))
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={['/applications/a1/follow-up']}><Routes><Route path="/applications/:id/follow-up" element={<FollowUpPage />} /></Routes></MemoryRouter></QueryClientProvider>)
  return calls
}

afterEach(() => vi.unstubAllGlobals())

describe('FollowUpPage', () => {
  it('shows the saved draft, lets you edit it and copies the edited text', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    setup({ email: draft, linkedin: null })
    const box = await screen.findByLabelText('Message')
    expect(box).toHaveValue(draft.body)
    expect(screen.getByText(/Replace \{name\}/)).toBeInTheDocument()
    await userEvent.clear(box)
    await userEvent.type(box, 'Short note')
    await userEvent.click(screen.getByRole('button', { name: /^Copy/ }))
    expect(writeText).toHaveBeenCalledWith('Short note')
    expect(await screen.findByText(/Copied/)).toBeInTheDocument()
  })

  it('writes a draft when none exists', async () => {
    const calls = setup({ email: null, linkedin: null })
    expect(await screen.findByLabelText('Message')).toHaveValue(draft.body)
    expect(calls).toContain('POST /v1/applications/a1/follow-ups')
  })

  it('marks the reminder done', async () => {
    const calls = setup({ email: draft, linkedin: null })
    await userEvent.click(await screen.findByRole('button', { name: /mark as followed up/ }))
    expect(await screen.findByText('Followed up')).toBeInTheDocument()
    await waitFor(() => expect(calls).toContain('POST /v1/reminders/r1/done'))
  })
})
