import type { Score } from '../apply/api'

// Small pure helpers shared by the document screens.

/**
 * The file name the API chose for a presigned link. The API signs the link
 * with response-content-disposition: attachment; filename="..."; reading it
 * back keeps what we show identical to what lands in the downloads folder.
 */
export function fileNameFromUrl(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const cd = new URL(url).searchParams.get('response-content-disposition')
    const m = cd?.match(/filename="?([^";]+)"?/)
    return m?.[1] ?? null
  } catch {
    return null
  }
}

/** "halcyon.example/blog" style label for a source link. */
export function hostOf(url: string): string {
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^www\./, '')
    const first = u.pathname.split('/').filter(Boolean)[0]
    return first ? `${host}/${first}` : host
  } catch {
    return url
  }
}

export function countWords(paragraphs: string[]): number {
  return paragraphs.reduce((n, p) => n + p.split(/\s+/).filter(Boolean).length, 0)
}

const rtf = typeof Intl !== 'undefined' && 'RelativeTimeFormat' in Intl ? new Intl.RelativeTimeFormat('en', { numeric: 'auto' }) : null

/** "2 days ago", "yesterday", "just now". */
export function ago(iso: string, now = Date.now()): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const s = Math.round((t - now) / 1000)
  const abs = Math.abs(s)
  if (abs < 60) return 'just now'
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [['minute', 60], ['hour', 3600], ['day', 86400], ['week', 604800], ['month', 2629800], ['year', 31557600]]
  let unit: Intl.RelativeTimeFormatUnit = 'minute'
  let size = 60
  for (const [u, n] of steps) if (abs >= n) { unit = u; size = n }
  const v = Math.round(s / size)
  return rtf ? rtf.format(v, unit) : `${Math.abs(v)} ${unit}${Math.abs(v) === 1 ? '' : 's'} ago`
}

/** "Wed 19 Nov". */
export function shortDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
}

/** "13 November 2026". */
export function longDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
}

/** "2021 to Present", "2018", or "". */
export function dateRange(start?: string | null, end?: string | null): string {
  const a = start?.trim()
  const b = end?.trim()
  if (a && b) return `${a} to ${b}`
  return a || b || ''
}

/** First sentence, used as the Research headline. */
export function firstSentence(text: string): { head: string; rest: string } {
  const m = text.match(/^(.+?[.!?])\s+(?=[A-Z0-9"“])/)
  if (!m) return { head: text.trim(), rest: '' }
  return { head: m[1]!.trim(), rest: text.slice(m[0].length).trim() }
}

export function capitalise(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s
}

/** The score to show: a real rescore when there is one, else the running estimate. */
export function shownScore(score: Score | undefined): number | null {
  return score?.rescored ?? score?.current ?? score?.before ?? null
}
