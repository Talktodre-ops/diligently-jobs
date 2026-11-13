import type { ResumeDoc } from './api'

export type Found = { label: string; value: string }

const listed = (items: string[], show: number) =>
  items.length > show ? `${items.slice(0, show).join(', ')} and ${items.length - show} more` : items.join(', ')

/** What we read, one line per fact, for the reveal on Upload. Facts the CV lacks are left out. */
export function foundFacts(doc: ResumeDoc): Found[] {
  const out: Found[] = []
  if (doc.header.name.trim()) out.push({ label: 'Name', value: doc.header.name.trim() })
  const [now, ...before] = doc.experience
  if (now) {
    const v = [now.role, now.company].map((x) => x?.trim()).filter(Boolean).join(', ')
    if (v) out.push({ label: 'Now', value: v })
  }
  const earlier = [...new Set(before.map((e) => e.company.trim()).filter(Boolean))]
  if (earlier.length) out.push({ label: 'Before', value: listed(earlier, 3) })
  const skills = doc.skills.flatMap((g) => g.items).map((x) => x.trim()).filter(Boolean)
  if (skills.length) out.push({ label: 'Skills', value: listed(skills, 4) })
  const ed = doc.education[0]
  if (ed) {
    const v = [ed.degree, ed.institution].map((x) => x?.trim()).filter(Boolean).join(', ')
    if (v) out.push({ label: 'Education', value: v })
  }
  return out
}

export type Candidate = { key: string; role: number; bullet: number; where: string; text: string }

/**
 * Bullets with no digit in them, most recent role first, at most three
 * (contract section 5). The first role in the CV is the most recent.
 */
export function strengthenCandidates(doc: ResumeDoc, max = 3): Candidate[] {
  const out: Candidate[] = []
  doc.experience.forEach((e, i) => {
    e.bullets.forEach((b, j) => {
      if (out.length < max && b.trim() && !/\d/.test(b)) {
        out.push({ key: `${i}.${j}`, role: i, bullet: j, where: [e.company, e.role].filter((x) => x?.trim()).join(', '), text: b.trim() })
      }
    })
  })
  return out
}

/** Deterministic merge: drop the bullet's full stop, add ", " and the answer, end with one full stop. */
export function mergeAnswer(bullet: string, answer: string) {
  const base = bullet.trim().replace(/\.+$/, '')
  const add = answer.trim().replace(/\.+$/, '')
  return add ? `${base}, ${add}.` : `${base}.`
}

/** US Letter for the United States and Canada, A4 everywhere else (contract section 6). */
export function inferPaper(location: string | null | undefined): 'a4' | 'letter' {
  return /\b(united states|usa|us|canada)\b/i.test(location ?? '') ? 'letter' : 'a4'
}

/** The country part of "City, Country", or the whole text when there is no comma. */
export function countryOf(location: string | null | undefined) {
  const parts = (location ?? '').split(',').map((x) => x.trim()).filter(Boolean)
  return parts[parts.length - 1] ?? ''
}
