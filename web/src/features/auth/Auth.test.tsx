import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../api/client'
import { passwordProblem } from './api'
import { toFormError } from './errors'
import ForgotPasswordPage from './ForgotPasswordPage'
import SignInPage from './SignInPage'
import SignUpPage from './SignUpPage'
import VerifyEmailPage from './VerifyEmailPage'

const user = { id: 'u', email: 'ada@example.com', email_verified: false, plan: 'free', created_at: '' }
type Reply = Response | undefined

function setup(ui: React.ReactElement, reply: (url: string, init?: RequestInit) => Reply, entry = '/x') {
  const calls: { url: string; method: string; body?: string }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined })
    return reply(url, init) ?? new Response('{}', { status: 404 })
  }))
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/x" element={ui} />
          <Route path="/verify-email" element={ui} />
          <Route path="/" element={<div>Home</div>} />
          <Route path="/welcome" element={<div>Welcome page</div>} />
          <Route path="/signup" element={<div>Sign up page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return calls
}
const json = (b: unknown, status = 200, headers?: Record<string, string>) => new Response(JSON.stringify(b), { status, headers })
const apiError = (status: number, code: string, message: string, field?: string, headers?: Record<string, string>) =>
  json({ error: { code, message, field } }, status, headers)

afterEach(() => vi.unstubAllGlobals())

describe('helpers', () => {
  it('mirrors the password policy', () => {
    expect(passwordProblem('short', 'a@b.co')).toMatch(/at least 10/)
    expect(passwordProblem('x'.repeat(129), 'a@b.co')).toMatch(/at most 128/)
    expect(passwordProblem('A@B.co-ABC', 'a@b.co-abc')).toMatch(/email/)
    expect(passwordProblem('a long enough one', 'a@b.co')).toBeNull()
  })
  it('turns a 429 into a wait message and keeps field names', () => {
    expect(toFormError(new ApiError(429, 'rate_limited', 'x', null, 90)).message).toMatch(/2 minutes/)
    expect(toFormError(new ApiError(422, 'invalid_input', 'bad', 'password', null))).toMatchObject({ field: 'password', message: 'bad' })
    expect(toFormError(new ApiError(409, 'email_taken', 'taken', null, null)).field).toBe('email')
  })
})

describe('SignUpPage', () => {
  it('checks the password on the client before calling the API', async () => {
    const calls = setup(<SignUpPage />, () => undefined)
    await userEvent.type(screen.getByLabelText('Email'), 'ada@example.com')
    await userEvent.type(screen.getByLabelText('Password'), 'short')
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByText('Use at least 10 characters.')).toBeInTheDocument()
    expect(calls).toHaveLength(0)
  })

  it('shows an API field error on the right input', async () => {
    setup(<SignUpPage />, (url) => (url === '/v1/auth/signup' ? apiError(409, 'email_taken', 'An account with this email already exists.') : undefined))
    await userEvent.type(screen.getByLabelText('Email'), 'ada@example.com')
    await userEvent.type(screen.getByLabelText('Password'), 'a long enough passphrase')
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }))
    const email = screen.getByLabelText('Email')
    await waitFor(() => expect(email).toHaveAttribute('aria-invalid', 'true'))
    expect(screen.getByText('An account with this email already exists.')).toBeInTheDocument()
  })

  it('goes to verify-email after a successful sign up', async () => {
    const calls = setup(<SignUpPage />, (url) => (url === '/v1/auth/signup' ? json({ user }, 201) : url === '/v1/auth/me' ? json({ user }) : undefined))
    await userEvent.type(screen.getByLabelText('Email'), 'ada@example.com')
    await userEvent.type(screen.getByLabelText('Password'), 'a long enough passphrase')
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }))
    await waitFor(() => expect(calls.some((c) => c.url === '/v1/auth/signup' && c.method === 'POST')).toBe(true))
  })
})

describe('SignInPage', () => {
  it('shows one shared message for wrong credentials and a rate limit message', async () => {
    let n = 0
    setup(<SignInPage />, (url) => {
      if (url !== '/v1/auth/signin') return undefined
      return ++n === 1 ? apiError(401, 'unauthorized', 'That email and password do not match.') : apiError(429, 'rate_limited', 'slow', undefined, { 'Retry-After': '30' })
    })
    await userEvent.type(screen.getByLabelText('Email'), 'ada@example.com')
    await userEvent.type(screen.getByLabelText('Password'), 'nope nope nope')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('That email and password do not match.')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Too many attempts. Try again in 30 seconds.'))
  })

  it('links to forgot password', () => {
    setup(<SignInPage />, () => undefined)
    expect(screen.getByRole('link', { name: 'Forgot password?' })).toHaveAttribute('href', '/forgot-password')
  })
})

describe('ForgotPasswordPage', () => {
  it('shows the same confirmation whatever the API says about the account', async () => {
    const calls = setup(<ForgotPasswordPage />, (url) => (url === '/v1/auth/forgot-password' ? json({ ok: true }, 202) : undefined))
    await userEvent.type(screen.getByLabelText('Email'), 'nobody@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }))
    expect(await screen.findByRole('heading', { name: 'Link sent' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('If an account exists for nobody@example.com')
    expect(JSON.parse(calls.find((c) => c.method === 'POST')!.body!)).toEqual({ email: 'nobody@example.com' })
  })
})

describe('VerifyEmailPage', () => {
  it('asks a signed-out visitor to go to the welcome screen', async () => {
    setup(<VerifyEmailPage />, (url) => (url === '/v1/auth/me' ? apiError(401, 'unauthorized', 'x') : undefined))
    expect(await screen.findByText('Welcome page')).toBeInTheDocument()
  })

  it('shows the inbox screen and resends, then counts down', async () => {
    const calls = setup(<VerifyEmailPage />, (url) => (url === '/v1/auth/me' ? json({ user }) : url === '/v1/auth/resend-verification' ? json({ ok: true }, 202) : undefined))
    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument()
    expect(screen.getByText('ada@example.com')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'send it again' }))
    expect(await screen.findByText('Sent a fresh link.')).toBeInTheDocument()
    expect(screen.getByText(/send it again in \d+s/)).toBeInTheDocument()
    expect(calls.filter((c) => c.url === '/v1/auth/resend-verification')).toHaveLength(1)
  })

  it('respects Retry-After when resending is rate limited', async () => {
    setup(<VerifyEmailPage />, (url) =>
      url === '/v1/auth/me' ? json({ user }) : url === '/v1/auth/resend-verification' ? apiError(429, 'rate_limited', 'slow', undefined, { 'Retry-After': '45' }) : undefined)
    await userEvent.click(await screen.findByRole('button', { name: 'send it again' }))
    expect(await screen.findByText(/Too many attempts. Try again in 45 seconds./)).toBeInTheDocument()
    expect(screen.getByText(/send it again in 45s/)).toBeInTheDocument()
  })

  it('posts the token from the link and moves a signed-in user on', async () => {
    const calls = setup(
      <VerifyEmailPage />,
      (url) => (url === '/v1/auth/verify' ? json({ ok: true }) : url === '/v1/auth/me' ? json({ user: { ...user, email_verified: true } }) : undefined),
      '/verify-email?token=abc',
    )
    expect(await screen.findByText('Home')).toBeInTheDocument()
    expect(JSON.parse(calls.find((c) => c.url === '/v1/auth/verify')!.body!)).toEqual({ token: 'abc' })
  })

  it('offers a fresh link when the token is expired and the user is signed in', async () => {
    setup(
      <VerifyEmailPage />,
      (url) => (url === '/v1/auth/verify' ? apiError(422, 'token_invalid', 'This link is invalid or has expired.') : url === '/v1/auth/me' ? json({ user }) : undefined),
      '/verify-email?token=old',
    )
    expect(await screen.findByRole('heading', { name: 'That link has expired' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Send me a new link/ })).toBeInTheDocument()
  })

  it('sends a signed-out visitor to sign in after confirming', async () => {
    setup(
      <VerifyEmailPage />,
      (url) => (url === '/v1/auth/verify' ? json({ ok: true }) : url === '/v1/auth/me' ? apiError(401, 'unauthorized', 'x') : undefined),
      '/verify-email?token=abc',
    )
    expect(await screen.findByRole('heading', { name: 'Email confirmed' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/signin')
  })
})
