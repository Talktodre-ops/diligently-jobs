import type { Gap, Rewrites, ResumeDoc } from '../apply/api'

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

/**
 * Text the user decided to change for this job: accepted or edited rewrites,
 * an accepted summary, and accepted bullets from the gaps. Only decisions the
 * server recorded count; nothing here is proposed by the client.
 */
export function changedTexts(rewrites: Rewrites | undefined, gaps: Gap[] | undefined): Set<string> {
  const out = new Set<string>()
  for (const r of rewrites?.rewrites ?? []) {
    if (r.status === 'accepted' || r.status === 'edited') out.add(norm(r.final_text ?? r.rewrite))
  }
  if (rewrites?.summary && rewrites.summary.status === 'accepted') out.add(norm(rewrites.summary.proposed))
  for (const g of gaps ?? []) {
    if (g.bullet_status === 'accepted' && g.suggested_bullet) out.add(norm(g.suggested_bullet))
  }
  return out
}

export const isChanged = (changed: Set<string>, text: string | null | undefined) => !!text && changed.has(norm(text))

/** How many places in the decided CV carry a change, for "N changes highlighted". */
export function countChanged(doc: ResumeDoc, changed: Set<string>): number {
  let n = isChanged(changed, doc.summary) ? 1 : 0
  for (const e of doc.experience) for (const b of e.bullets) if (isChanged(changed, b)) n++
  return n
}

/** A PDF line is part of a changed passage only if it sits on word edges
 *  ("Experience" the heading is not part of "Experienced with"). */
export function containsAtWordBoundary(haystack: string, needle: string): boolean {
  const word = /[\p{L}\p{N}]/u
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) {
    const before = haystack[i - 1]
    const after = haystack[i + needle.length]
    if ((!before || !word.test(before)) && (!after || !word.test(after))) return true
  }
  return false
}
