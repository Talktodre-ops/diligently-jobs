import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ProfilePage from './ProfilePage'
import SettingsPage from './SettingsPage'

const profile = {
  full_name: 'Ada Okafor', headline: 'Senior Backend Engineer', location: 'Lagos', target_roles: ['Backend Engineer'],
  work_settings: ['remote'], paper_size: 'a4', theme: 'system',
  notifications: { follow_ups: true, weekly_summary: true, running_low: true, product_news: false },
  reminders: { follow_up_days: 7, send_hour: 9, time_zone: 'Africa/Lagos', skip_weekends: true },
  writing: { spelling: null, letter_tone: 'direct' },
  onboarding_step: 'done', updated_at: '',
}
const baseUser: { id: string; email: string; email_verified: boolean; plan: string; created_at: string; has_password: boolean; google_connected: boolean; password_changed_at: string | null } = {
  id: 'u', email: 'ada@example.com', email_verified: true, plan: 'free', created_at: '',
  has_password: true, google_connected: false, password_changed_at: '2026-10-12T09:14:00Z',
}
const cv = { id: 'c', doc: { header: { name: 'Ada Okafor' }, experience: [{ role: 'Eng', company: 'Northfold', start: '2021', end: 'Present' }], education: [], skills: [], projects: [] }, issues: [], updated_at: new Date().toISOString() }

type Call = { url: string; method: string; body?: string }
type Opts = { user?: Partial<typeof baseUser>; google?: boolean; path?: string }

/** Shows the address the page ended on, so a test can check a cleared query. */
function Where() {
  const l = useLocation()
  return <div data-testid="where">{l.pathname + l.search}</div>
}

function setup(ui: React.ReactElement, extra: (url: string, init?: RequestInit) => Response | undefined = () => undefined, opts: Opts = {}) {
  const calls: Call[] = []
  const user = { ...baseUser, ...opts.user }
  // The fake API keeps what was saved, like the real one.
  let stored = structuredClone(profile)
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined })
    const hit = extra(url, init)
    if (hit) return hit
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
    if (url === '/v1/profile' && init?.method === 'PATCH') {
      const patch = JSON.parse(init.body as string)
      const merged = { ...stored, ...patch }
      for (const k of ['notifications', 'reminders', 'writing'] as const) if (patch[k]) merged[k] = { ...stored[k], ...patch[k] }
      stored = merged
      return json({ profile: stored })
    }
    if (url === '/v1/profile') return json({ profile: stored })
    if (url === '/v1/auth/me') return json({ user })
    if (url === '/v1/auth/providers') return json({ google: opts.google ?? true })
    if (url === '/v1/cv/master') return json({ cv })
    if (url === '/v1/usage') return json({ plan: 'free', applications_this_month: 3, monthly_limit: 10, resets_on: '2026-12-01T00:00:00Z' })
    if (url === '/v1/auth/sessions') return json({ sessions: [
      { id: 's1', user_agent: 'Mozilla/5.0 Edg/130 Windows', ip: '1.1.1.1', created_at: '', last_seen_at: new Date().toISOString(), current: true },
      { id: 's2', user_agent: 'Mozilla/5.0 Firefox/130 Linux', ip: '2.2.2.2', created_at: '', last_seen_at: new Date().toISOString(), current: false },
    ] })
    return new Response('{}', { status: 404 })
  }))
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[opts.path ?? '/x']}>
        <Routes>
          <Route path="/x" element={<>{ui}<Where /></>} />
          <Route path="/welcome" element={<div>Welcome page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return calls
}

const patches = (calls: Call[]) => calls.filter((c) => c.method === 'PATCH').map((c) => c.body)

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
  it('shows the sections in order', async () => {
    setup(<SettingsPage />)
    await screen.findByRole('heading', { name: 'Account' })
    const names = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    expect(names).toEqual(['Account', 'Reminders', 'Emails we send you', 'Your documents', 'Appearance', 'Plan', 'Signed-in devices', 'Privacy and data'])
    const nav = screen.getByRole('navigation', { name: 'Settings sections' })
    expect(within(nav).getByRole('link', { name: 'Reminders' })).toHaveAttribute('href', '#reminders')
    expect(within(nav).getByRole('link', { name: 'Account' })).toHaveAttribute('aria-current', 'true')
  })

  it('saves every control on its own and says Saved', async () => {
    const calls = setup(<SettingsPage />)
    await userEvent.click(await screen.findByRole('radio', { name: 'Dark' }))
    await userEvent.click(screen.getByRole('radio', { name: 'US Letter' }))
    await userEvent.click(screen.getByRole('switch', { name: 'Product news' }))
    await userEvent.click(screen.getByRole('switch', { name: 'Monday summary' }))
    await userEvent.click(screen.getByRole('radio', { name: '14 days' }))
    await userEvent.click(screen.getByRole('radio', { name: /Evening/ }))
    await userEvent.click(screen.getByRole('switch', { name: 'Keep weekends quiet' }))
    await userEvent.click(screen.getByRole('radio', { name: 'American' }))
    await userEvent.click(screen.getByRole('radio', { name: 'Warm' }))
    await waitFor(() => expect(patches(calls)).toEqual([
      '{"theme":"dark"}',
      '{"paper_size":"letter"}',
      '{"notifications":{"product_news":true}}',
      '{"notifications":{"weekly_summary":false}}',
      '{"reminders":{"follow_up_days":14}}',
      '{"reminders":{"send_hour":18}}',
      '{"reminders":{"skip_weekends":false}}',
      '{"writing":{"spelling":"en-US"}}',
      '{"writing":{"letter_tone":"warm"}}',
    ]))
    expect(await screen.findByText('Saved')).toHaveAttribute('role', 'status')
    expect(screen.getByRole('switch', { name: 'Product news' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: '14 days' })).toHaveAttribute('aria-checked', 'true')
  })

  it('never sends interview_prep', async () => {
    const calls = setup(<SettingsPage />)
    await userEvent.click(await screen.findByRole('switch', { name: 'Follow-up reminders' }))
    await waitFor(() => expect(patches(calls)).toEqual(['{"notifications":{"follow_ups":false}}']))
    expect(screen.queryByText(/Interview prep/i)).not.toBeInTheDocument()
  })

  it('moves through a choice with the arrow keys', async () => {
    const calls = setup(<SettingsPage />)
    const seven = await screen.findByRole('radio', { name: '7 days' })
    expect(seven).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('radio', { name: '5 days' })).toHaveAttribute('tabindex', '-1')
    seven.focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.getByRole('radio', { name: '10 days' })).toHaveFocus()
    await waitFor(() => expect(patches(calls)).toEqual(['{"reminders":{"follow_up_days":10}}']))
  })

  it('puts a setting back and shows why when the save fails', async () => {
    setup(<SettingsPage />, (url, init) => (url === '/v1/profile' && init?.method === 'PATCH'
      ? new Response(JSON.stringify({ error: { code: 'internal', message: 'The server had a problem.' } }), { status: 500 }) : undefined))
    const news = await screen.findByRole('switch', { name: 'Product news' })
    await userEvent.click(news)
    expect(await screen.findByRole('alert')).toHaveTextContent('That did not save, so it is back as it was. The server had a problem.')
    expect(news).toHaveAttribute('aria-checked', 'false')
  })

  it('shows the inferred spelling when none is stored', async () => {
    setup(<SettingsPage />)
    expect(await screen.findByRole('radio', { name: 'British' })).toHaveAttribute('aria-checked', 'true')
  })

  it('changes the time zone through the searchable list', async () => {
    const calls = setup(<SettingsPage />)
    expect(await screen.findByText(/Time zone: Lagos \(GMT\+1\)/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Change time zone' }))
    const dialog = screen.getByRole('dialog', { name: 'Your time zone' })
    await userEvent.type(within(dialog).getByLabelText('Search for a city'), 'tokyo')
    await userEvent.click(within(dialog).getByRole('button', { name: /^Tokyo/ }))
    await waitFor(() => expect(patches(calls)).toEqual(['{"reminders":{"time_zone":"Asia/Tokyo"}}']))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(await screen.findByText(/Time zone: Tokyo \(GMT\+9\)/)).toBeInTheDocument()
  })

  it('says when no time zone matches', async () => {
    setup(<SettingsPage />)
    await userEvent.click(await screen.findByRole('button', { name: 'Change time zone' }))
    const dialog = screen.getByRole('dialog', { name: 'Your time zone' })
    await userEvent.type(within(dialog).getByLabelText('Search for a city'), 'qqqzzz')
    expect(within(dialog).getByText(/Nothing matches qqqzzz/)).toBeInTheDocument()
  })

  it('with a password: Change, last changed date, Google connect link', async () => {
    setup(<SettingsPage />)
    expect(await screen.findByRole('button', { name: 'Change password' })).toBeInTheDocument()
    expect(screen.getByText(/Last changed (12 October|October 12)/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Connect Google' })).toHaveAttribute('href', '/v1/auth/google/start?next=/settings&link=1')
  })

  it('hides the Google row when Google sign-in is off', async () => {
    setup(<SettingsPage />, undefined, { google: false })
    await screen.findByRole('button', { name: 'Change password' })
    expect(screen.queryByText('Google')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Connect Google' })).not.toBeInTheDocument()
  })

  it('disconnects Google after confirming', async () => {
    const calls = setup(<SettingsPage />, (url) => (url === '/v1/account/google/disconnect'
      ? new Response(JSON.stringify({ user: { ...baseUser, google_connected: false } }), { status: 200 }) : undefined), { user: { google_connected: true } })
    await userEvent.click(await screen.findByRole('button', { name: 'Disconnect Google' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Disconnect Google?' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/v1/account/google/disconnect')).toBe(true))
    expect(await screen.findByRole('link', { name: 'Connect Google' })).toBeInTheDocument()
  })

  it('without a password: Set a password, no Disconnect', async () => {
    const calls = setup(<SettingsPage />, (url) => (url === '/v1/account/set-password-link' ? new Response(null, { status: 204 }) : undefined),
      { user: { has_password: false, google_connected: true, password_changed_at: null } })
    await userEvent.click(await screen.findByRole('button', { name: 'Set a password' }))
    expect(screen.queryByRole('button', { name: 'Disconnect Google' })).not.toBeInTheDocument()
    expect(await screen.findByRole('dialog', { name: 'Check your inbox' })).toHaveTextContent('We sent a link to ada@example.com')
    expect(calls.some((c) => c.method === 'POST' && c.url === '/v1/account/set-password-link')).toBe(true)
  })

  it('shows the Google result from the address, then clears it', async () => {
    setup(<SettingsPage />, undefined, { path: '/x?google=in_use' })
    expect(await screen.findByText(/already belongs to another Diligently account/)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/x$/))
  })

  it('says Google is connected after the round trip', async () => {
    setup(<SettingsPage />, undefined, { path: '/x?google=connected' })
    expect(await screen.findByText('Google is connected. You can sign in with it now.')).toBeInTheDocument()
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

  it('deletes a no-password account with an emailed code', async () => {
    let tries = 0
    const calls = setup(<SettingsPage />, (url, init) => {
      if (url === '/v1/account/delete-code') return new Response(null, { status: 204 })
      if (url === '/v1/account' && init?.method === 'DELETE') {
        tries += 1
        return tries === 1
          ? new Response(JSON.stringify({ error: { code: 'invalid_code', message: 'That code is not right.', field: 'code' } }), { status: 400 })
          : new Response(null, { status: 204 })
      }
      return undefined
    }, { user: { has_password: false, google_connected: true, password_changed_at: null } })
    await userEvent.click(await screen.findByRole('button', { name: 'Delete account' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Delete your account?' })
    expect(within(dialog).queryByLabelText('Your password')).not.toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Email me a code' }))
    const field = await within(dialog).findByLabelText('Code from the email')
    expect(dialog).toHaveTextContent('We sent a 6-digit code to ada@example.com')

    await userEvent.type(field, '12a3')
    expect(field).toHaveValue('123')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete my account' }))
    expect(await within(dialog).findByText('Enter all 6 digits from the email.')).toBeInTheDocument()
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)

    await userEvent.type(field, '999')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete my account' }))
    expect(await within(dialog).findByText('That code is not right.')).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete my account' }))
    expect(await screen.findByText('Welcome page')).toBeInTheDocument()
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.body)).toEqual(['{"code":"123999"}', '{"code":"123999"}'])
  })

  it('tells an expired code apart', async () => {
    setup(<SettingsPage />, (url, init) => {
      if (url === '/v1/account/delete-code') return new Response(null, { status: 204 })
      if (url === '/v1/account' && init?.method === 'DELETE') return new Response(JSON.stringify({ error: { code: 'code_expired', message: 'That code has expired.' } }), { status: 410 })
      return undefined
    }, { user: { has_password: false, google_connected: true, password_changed_at: null } })
    await userEvent.click(await screen.findByRole('button', { name: 'Delete account' }))
    const dialog = screen.getByRole('alertdialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Email me a code' }))
    await userEvent.type(await within(dialog).findByLabelText('Code from the email'), '123456')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete my account' }))
    expect(await within(dialog).findByText('That code has expired. Send a new one.')).toBeInTheDocument()
  })
})
