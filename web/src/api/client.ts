// One fetch wrapper for the whole app. Same-origin (Vite proxies /v1 in dev,
// the web server does in production), so the HttpOnly session cookie rides
// along and the API's origin check passes without CORS.

export type ApiErrorBody = { error: { code: string; message: string; field?: string | null } }

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly field: string | null
  readonly retryAfter: number | null

  constructor(status: number, code: string, message: string, field: string | null, retryAfter: number | null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.field = field
    this.retryAfter = retryAfter
  }
}

export function isApiError(e: unknown, code?: string): e is ApiError {
  return e instanceof ApiError && (code === undefined || e.code === code)
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

async function request<T>(method: Method, path: string, body?: unknown, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  let payload: BodyInit | undefined
  if (body instanceof FormData) {
    payload = body
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  let res: Response
  try {
    res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin', ...init })
  } catch {
    throw new ApiError(0, 'network', 'You appear to be offline. Check your connection and try again.', null, null)
  }
  if (res.status === 204) return undefined as T
  const text = await res.text()
  let json: unknown = undefined
  if (text) {
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
  }
  if (!res.ok) {
    const err = (json as ApiErrorBody | undefined)?.error
    const retry = res.headers.get('Retry-After')
    throw new ApiError(
      res.status,
      err?.code ?? 'http_' + res.status,
      err?.message ?? 'Something went wrong. Try again.',
      err?.field ?? null,
      retry ? Number(retry) : null,
    )
  }
  return json as T
}

export const api = {
  get: <T>(path: string, init?: RequestInit) => request<T>('GET', path, undefined, init),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  del: <T = void>(path: string) => request<T>('DELETE', path),
}
