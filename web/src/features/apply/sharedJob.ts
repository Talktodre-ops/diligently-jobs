import { looksLikeUrl } from './startErrors'

const URL_IN_TEXT = /https?:\/\/[^\s<>"']+/i

/**
 * A job shared into the app: from the phone's share sheet (Android opens
 * `/new?title=&text=&url=`) or the iPhone shortcut (`/new?url=`). Apps put
 * the link in different fields, often inside the text ("Check out this job:
 * https://..."), so the first link anywhere wins. With no link, the shared
 * text is treated as the job description.
 */
export function sharedJob(params: URLSearchParams): string | null {
  const url = params.get('url')?.trim() ?? ''
  const text = params.get('text')?.trim() ?? ''
  const title = params.get('title')?.trim() ?? ''
  if (url && looksLikeUrl(url)) return url
  const found = `${text} ${title}`.match(URL_IN_TEXT)?.[0]
  if (found) return found.replace(/[.,;:!?)\]]+$/, '')
  const body = [title, text].filter(Boolean).join('\n\n')
  return body || null
}
