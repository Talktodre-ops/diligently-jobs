import type { Rewrites } from './api'

/** One proposal the user decides on: the summary or a bullet rewrite. */
export type ReviewItem = {
  kind: 'summary' | 'bullet'
  id: string
  where: string
  original: string
  rewrite: string
  why: string | null
  needsNumber: boolean
  /** pending, accepted, kept or edited */
  status: string
  /** The text that is on the tailored CV for this item now. */
  chosen: string
}

/** The summary first (it sits at the top of the CV), then bullets in CV order. */
export function reviewItems(data: Rewrites): ReviewItem[] {
  const items: ReviewItem[] = []
  if (data.summary) {
    items.push({
      kind: 'summary',
      id: 'summary',
      where: 'Summary',
      original: data.summary.original ?? '',
      rewrite: data.summary.proposed,
      why: null,
      needsNumber: false,
      status: data.summary.status,
      chosen: data.summary.status === 'kept' ? (data.summary.original ?? '') : data.summary.proposed,
    })
  }
  for (const r of data.rewrites) {
    items.push({
      kind: 'bullet',
      id: r.id,
      where: r.section ? `${r.section} · Experience` : 'Experience',
      original: r.original,
      rewrite: r.status === 'edited' && r.final_text ? r.final_text : r.rewrite,
      why: r.why,
      needsNumber: r.needs_number,
      status: r.status,
      chosen: r.status === 'kept' ? r.original : r.status === 'edited' && r.final_text ? r.final_text : r.rewrite,
    })
  }
  return items
}

export function decisionWord(status: string) {
  if (status === 'accepted') return 'Using the rewrite'
  if (status === 'edited') return 'Using your edit'
  if (status === 'kept') return 'Keeping your original'
  return 'Waiting for you'
}
