import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ProfilePage from './ProfilePage'
import SettingsPage from './SettingsPage'

const profile = {
  full_name: 'Ada Okafor', headline: 'Senior Backend Engineer', location: 'Lagos', target_roles: ['Backend Engineer'],
  work_settings: ['remote'], paper_size: 'a4', theme: 'system',
  notifications: { follow_ups: true, interview_prep: true, product_news: false }, onboarding_step: 'done', updated_at: '',
}
const cv = { id: 'c', doc: { header: { name: 'Ada Okafor' }, experience: [{ role: 'Eng', company: 'Northfold', start: '2021', end: 'Present' }], education: [], skills: [], projects: [] }, issues: [], updated_at: new Date().toISOString() }

type Call = { url: string; method: string; body?: string }
function setup(ui: React.ReactElement, extra: (url: string, init?: RequestInit) => Response | undefined = () => undefined) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined })
    const hit = extra(url, init)
    if (hit) return hit
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
    if (url === '/v1/profile' && init?.method === 'PATCH') return json({ profile: { ...profile, ...JSON.parse(init.body as string) } })
    if (url === '/v1/profile') return json({ profile })
    if (url === '/v1/auth/me') return json({ user: { id: 'u', email: 'ada@example.com', email_verified: true, plan: 'free', created_at: '' } })
    if (url === '/v1/cv/master') return json({ cv })
    if (url === '/v1/usage') return json({ plan: 'free', applications_this_month: 3, monthly_limit: 10, resets_on: '2026-12-01T00:00:00Z' })
    if (url === '/v1/auth/sessions') return json({ sessions: [
      { id: 's1', user_agent: 'Mozilla/5.0 Edg/130 Windows', ip: '1.1.1.1', created_at: '', last_seen_at: new Date().toISOString(), current: true },
      { id: 's2', user_agent: 'Mozilla/5.0 Firefox/130 Linux', ip: '2.2.2.2', created_at: '', last_seen_at: new Date().toISOString(), current: false },
    ] })
    return new Response('{}', { status: 404 })
  }))
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={['/x']}><Routes><Route path="/x" element={ui} /><Route path="/welcome" element={<div>Welcome page</div>} /></Routes></MemoryRouter></QueryClientProvider>)
  return calls
}

afterEach(() => vi.unstubAllGlobals())

describe('ProfilePage', () => {
  it('sends only the changed field when editing', async () => {
    const calls = setup(<ProfilePage />)
    await userEvent.click(await screen.findByRole('button', { name: 'Edit your details' }))
    const loc = screen.getByLabelText('Location')
    await userEvent.clear(loc)
    await userEvent.type(loc, 'Abuja')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toBe('{"location":"Abuja"}'))
  })

  it('shows the master CV summary', async () => {
    setup(<ProfilePage />)
    expect(await screen.findByText(/Northfold · Eng · 2021 to Present/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Upload new' })).toBeInTheDocument()
  })
})

describe('SettingsPage', () => {
  it('patches theme, paper and one notification on their own', async () => {
    const calls = setup(<SettingsPage />)
    await userEvent.click(await screen.findByRole('radio', { name: 'Dark' }))
    await userEvent.click(screen.getByRole('radio', { name: 'US Letter' }))
    await userEvent.click(screen.getByRole('switch', { name: 'Product news' }))
    await waitFor(() => {
      const bodies = calls.filter((c) => c.method === 'PATCH').map((c) => c.body)
      expect(bodies).toEqual(['{"theme":"dark"}', '{"paper_size":"letter"}', '{"notifications":{"product_news":true}}'])
    })
  })

  it('revokes another device only after confirming', async () => {
    const calls = setup(<SettingsPage />, (url, init) => (url === '/v1/auth/sessions/s2' && init?.method === 'DELETE' ? new Response(null, { status: 204 }) : undefined))
    await userEvent.click(await screen.findByRole('button', { name: /Sign out Firefox on Linux/ }))
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    const dialog = screen.getByRole('alertdialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Sign it out' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === '/v1/auth/sessions/s2')).toBe(true))
  })

  it('deletes the account with the password and goes to welcome', async () => {
    const calls = setup(<SettingsPage />, (url, init) => (url === '/v1/account' && init?.method === 'DELETE' ? new Response(null, { status: 204 }) : undefined))
    await userEvent.click(await screen.findByRole('button', { name: 'Delete account' }))
    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveTextContent('cannot be undone')
    await userEvent.type(within(dialog).getByLabelText('Your password'), 'secret-pass-1')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete everything' }))
    expect(await screen.findByText('Welcome page')).toBeInTheDocument()
    expect(calls.find((c) => c.method === 'DELETE')?.body).toBe('{"password":"secret-pass-1"}')
  })

  it('shows a wrong password on the field', async () => {
    setup(<SettingsPage />, (url, init) => (url === '/v1/account' && init?.method === 'DELETE'
      ? new Response(JSON.stringify({ error: { code: 'invalid_input', message: 'That password is not right', field: 'password' } }), { status: 422 }) : undefined))
    await userEvent.click(await screen.findByRole('button', { name: 'Delete account' }))
    const dialog = screen.getByRole('alertdialog')
    await userEvent.type(within(dialog).getByLabelText('Your password'), 'wrong-password')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete everything' }))
    expect(await within(dialog).findByText('That password is not right')).toBeInTheDocument()
  })
})
