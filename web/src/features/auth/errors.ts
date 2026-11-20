import { isApiError } from '../../api/client'

export type FormError = { field: string | null; message: string; code: string | null }

/** Turn anything thrown by the API client into a message for the form, naming the input when the API did. */
export function toFormError(e: unknown, fallbackField: string | null = null): FormError {
  if (isApiError(e)) {
    if (e.status === 429 || e.code === 'rate_limited') {
      const wait = e.retryAfter && e.retryAfter > 0 ? ` Try again in ${formatWait(e.retryAfter)}.` : ' Try again in a moment.'
      return { field: null, code: e.code, message: `Too many attempts.${wait}` }
    }
    return { field: e.field ?? (e.code === 'email_taken' ? 'email' : fallbackField), message: e.message, code: e.code }
  }
  return { field: null, code: null, message: 'Something went wrong on our side. Try again.' }
}

export function formatWait(seconds: number) {
  if (seconds < 90) return `${Math.ceil(seconds)} seconds`
  return `${Math.ceil(seconds / 60)} minutes`
}
