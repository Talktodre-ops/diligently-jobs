import { useQuery } from '@tanstack/react-query'
import { api } from '../../api/client'
import type { User } from '../../api/types'

type Credentials = { email: string; password: string }

export const authApi = {
  signUp: (b: Credentials) => api.post<{ user: User }>('/v1/auth/signup', b).then((r) => r.user),
  signIn: (b: Credentials) => api.post<{ user: User }>('/v1/auth/signin', b).then((r) => r.user),
  signOut: () => api.post<void>('/v1/auth/signout'),
  verify: (token: string) => api.post<{ ok: true }>('/v1/auth/verify', { token }),
  verifyCode: (code: string) => api.post<{ user: User }>('/v1/auth/verify-code', { code }).then((r) => r.user),
  resendVerification: () => api.post<{ ok: true }>('/v1/auth/resend-verification'),
  forgotPassword: (email: string) => api.post<{ ok: true }>('/v1/auth/forgot-password', { email }),
  resetPassword: (b: { token: string; password: string }) => api.post<{ user: User }>('/v1/auth/reset-password', b).then((r) => r.user),
  confirmEmail: (token: string) => api.post<{ ok: true }>('/v1/auth/confirm-email', { token }),
}

/** Client-side checks that mirror the API's password policy, so the common mistakes show up before a round trip. */
export function passwordProblem(password: string, email: string): string | null {
  if (password.length < 10) return 'Use at least 10 characters.'
  if (password.length > 128) return 'Use at most 128 characters.'
  if (email && password.toLowerCase() === email.trim().toLowerCase()) return 'Your password cannot be your email address.'
  return null
}

export type Providers = { google: boolean }

/** Which sign-in providers the API has configured. Off (or unreachable) means email only. */
export function useProviders() {
  return useQuery({
    queryKey: ['auth', 'providers'],
    queryFn: () => api.get<Providers>('/v1/auth/providers'),
    staleTime: 5 * 60_000,
    retry: false,
  })
}

/** Full-page address that starts Google sign-in and comes back to `next` (a path in this app). */
export function googleStartUrl(next: string) {
  const safe = next.startsWith('/') && !next.startsWith('//') ? next : '/'
  return `/v1/auth/google/start?next=${encodeURIComponent(safe)}`
}
