import { isApiError } from '../../api/client'

export type StartProblem = {
  /** Which input the message belongs to, when it belongs to one. */
  field: 'jd_text' | 'url' | null
  message: string
  /** A next step the user can take, e.g. upload a CV or see their plan. */
  action?: { to: string; label: string }
  /** The link could not be read: the screen should offer the text box instead. */
  pasteInstead?: boolean
}

/** Turns a failed POST /v1/applications/start into something a screen can show. */
export function startProblem(e: unknown): StartProblem {
  if (!isApiError(e)) return { field: null, message: 'Something went wrong on our side. Try again.' }
  switch (e.code) {
    case 'no_master_cv':
      return { field: null, message: e.message, action: { to: '/onboarding/upload', label: 'Upload your CV' } }
    case 'plan_limit_reached':
      return { field: null, message: e.message, action: { to: '/settings', label: 'See your plan' } }
    case 'link_unreadable':
      return { field: 'url', message: e.message, pasteInstead: true }
    case 'invalid_input':
      return { field: e.field === 'url' ? 'url' : e.field === 'jd_text' ? 'jd_text' : null, message: e.message }
    case 'rate_limited':
      return {
        field: null,
        message: e.retryAfter ? `Too many tries. Wait ${e.retryAfter} seconds and try again.` : e.message,
      }
    default:
      return { field: null, message: e.message }
  }
}

/** A pasted value that is only a web address. */
export function looksLikeUrl(value: string) {
  return /^https?:\/\/\S+$/i.test(value.trim())
}

export const MIN_JD_CHARS = 200
