import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RequireAccount } from './gates'
import { browserTimeZone } from './timeZone'

const user = { id: 'u', email: 'ada@example.com', email_verified: true, plan: 'free', created_at: '', has_password: true, google_connected: false, password_changed_at: null }
const profile = (reminders: unknown) => ({
  full_name: 'Ada', headline: null, location: null, target_roles: [], work_settings: [], paper_size: 'a4', theme: 'system',
  notifications: { follow_ups: true, weekly_summary: true, running_low: true, product_news: false },
  reminders, writing: { spelling: null, letter_tone: 'direct' }, onboarding_step: 'done', updated_at: '',
})
const reminders = (time_zone: string | null) => ({ follow_up_days: 7, send_hour: 9, time_zone, skip_weekends: true })

function setup(p: unknown) {
  const calls: { method: string; body?: string }[] = []
  let current = p
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
    if (url === '/v1/auth/me') return json({ user })
    if (url === '/v1/profile' && init?.method === 'PATCH') {
      calls.push({ method: 'PATCH', body: init.body as string })
      const patch = JSON.parse(init.body as string) as { reminders: object }
      current = { ...(current as object), reminders: { ...(current as { reminders: object }).reminders, ...patch.reminders } }
      return json({ profile: current })
    }
    if (url === '/v1/profile') return json({ profile: current })
    return new Response('{}', { status: 404 })
  }))
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route element={<RequireAccount />}><Route path="/" element={<div>Home page</div>} /></Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { calls, view }
}

afterEach(() => vi.unstubAllGlobals())

describe('time zone sync', () => {
  it('sends the browser zone once when the profile has none', async () => {
    const zone = browserTimeZone()
    expect(zone).toBeTruthy()
    const { calls, view } = setup(profile(reminders(null)))
    expect(await screen.findByText('Home page')).toBeInTheDocument()
    await waitFor(() => expect(calls).toEqual([{ method: 'PATCH', body: JSON.stringify({ reminders: { time_zone: zone } }) }]))
    view.rerender(<div />)
    expect(calls).toHaveLength(1)
  })

  it('leaves a stored zone alone', async () => {
    const { calls } = setup(profile(reminders('Africa/Lagos')))
    expect(await screen.findByText('Home page')).toBeInTheDocument()
    await new Promise((r) => setTimeout(r, 20))
    expect(calls).toEqual([])
  })

  it('does nothing when the API has no reminders yet', async () => {
    const { calls } = setup(profile(undefined))
    expect(await screen.findByText('Home page')).toBeInTheDocument()
    await new Promise((r) => setTimeout(r, 20))
    expect(calls).toEqual([])
  })
})
