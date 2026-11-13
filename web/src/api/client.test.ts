import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api, isApiError } from './client'

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status, headers })),
  )
}

afterEach(() => vi.unstubAllGlobals())

describe('api client', () => {
  it('returns parsed JSON on success and sends the cookie', async () => {
    mockFetch(200, { user: { id: '1' } })
    await expect(api.get('/v1/auth/me')).resolves.toEqual({ user: { id: '1' } })
    const call = vi.mocked(fetch).mock.calls[0]!
    expect(call[1]?.credentials).toBe('same-origin')
  })

  it('turns the error envelope into an ApiError with code and field', async () => {
    mockFetch(422, { error: { code: 'invalid_input', message: 'Use at least 10 characters', field: 'password' } })
    const err = await api.post('/v1/auth/signup', { email: 'a@b.co', password: 'x' }).catch((e) => e)
    expect(isApiError(err, 'invalid_input')).toBe(true)
    expect((err as ApiError).field).toBe('password')
    expect((err as ApiError).message).toBe('Use at least 10 characters')
  })

  it('reads Retry-After on 429', async () => {
    mockFetch(429, { error: { code: 'rate_limited', message: 'Slow down' } }, { 'Retry-After': '30' })
    const err = (await api.post('/v1/auth/signin', {}).catch((e) => e)) as ApiError
    expect(err.retryAfter).toBe(30)
  })

  it('maps a network failure to a readable offline error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const err = (await api.get('/v1/home').catch((e) => e)) as ApiError
    expect(err.code).toBe('network')
  })

  it('returns undefined for 204', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
    await expect(api.del('/v1/auth/sessions/x')).resolves.toBeUndefined()
  })
})
