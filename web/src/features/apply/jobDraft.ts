// A job pasted before the user had a CV. It is kept in this tab while they
// add one, and New job picks it up again. Storage can be missing or blocked
// (private windows), so every access is guarded and losing it is harmless.
const KEY = 'diligently:job-draft'

export function saveJobDraft(text: string) {
  try {
    sessionStorage.setItem(KEY, text)
  } catch {
    // Nothing to do: the user pastes the job again.
  }
}

export function loadJobDraft(): string | null {
  try {
    return sessionStorage.getItem(KEY)
  } catch {
    return null
  }
}

export function clearJobDraft() {
  try {
    sessionStorage.removeItem(KEY)
  } catch {
    // Already gone or unreachable.
  }
}
