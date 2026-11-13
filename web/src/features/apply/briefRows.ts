import type { IconName } from '../../ui/Icon'
import type { Brief } from './api'
import { plural } from './format'

export type BriefRow = {
  key: 'cv' | 'gaps' | 'research' | 'letter'
  icon: IconName
  tone: 'butter' | 'persimmon' | 'lilac'
  title: string
  sub: string
  action: string
  to: string
}

/** Proposals waiting for a decision: bullet rewrites plus the summary, as the score counts them. */
export function proposalCounts(b: Brief) {
  const total = b.rewrites.total + (b.summary.proposed ? 1 : 0)
  return { total, waiting: b.score.pending }
}

/** Requirements the CV does not fully show, answered or not. */
export function openGaps(b: Brief) {
  return b.gaps.missing + b.gaps.partial
}

/** The rows under the score: CV, gaps, research, letter. */
export function briefRows(id: string, b: Brief): BriefRow[] {
  const base = `/applications/${id}`
  const { total, waiting } = proposalCounts(b)
  const cv: BriefRow = {
    key: 'cv',
    icon: 'document',
    tone: 'butter',
    title: total === 0 ? 'CV checked' : 'CV tailored',
    sub:
      total === 0
        ? 'No changes suggested for this job'
        : waiting > 0
          ? `${plural(total, 'rewrite')} · ${waiting} waiting for you`
          : `${plural(total, 'rewrite')} · all decided`,
    action: waiting > 0 ? 'Review' : 'Change',
    to: `${base}/review`,
  }
  const gapCount = openGaps(b)
  const gaps: BriefRow = {
    key: 'gaps',
    icon: 'alert',
    tone: 'persimmon',
    title:
      gapCount === 0 ? 'No gaps found' : b.gaps.unanswered > 0 ? `${plural(b.gaps.unanswered, 'gap')} to address` : 'Gaps answered',
    sub:
      gapCount === 0
        ? 'Your CV shows what the job asks for'
        : b.gaps.unanswered > 0
          ? b.gaps.top.join(' · ')
          : `You answered all ${gapCount}`,
    action: b.gaps.unanswered > 0 ? 'Fix' : 'See',
    to: `${base}/gaps`,
  }
  const research: BriefRow = {
    key: 'research',
    icon: 'search',
    tone: 'lilac',
    title: 'Company research',
    sub: b.research
      ? b.research.overview || (b.research.talking_points ? plural(b.research.talking_points, 'talking point') : 'Little found online')
      : 'Not researched yet',
    action: b.research ? 'Read' : 'Open',
    to: `${base}/research`,
  }
  const letter: BriefRow = {
    key: 'letter',
    icon: 'edit',
    tone: 'lilac',
    title: 'Cover letter',
    sub: b.letter ? `Drafted${b.letter.words ? ` · ${b.letter.words} words` : ''}` : 'Not drafted yet',
    action: b.letter ? 'Open' : 'Write',
    to: `${base}/letter`,
  }
  return [cv, gaps, research, letter]
}

/** The line at the top of the score card. */
export function scoreStatus(b: Brief) {
  const { waiting } = proposalCounts(b)
  if (waiting > 0) return `${plural(waiting, 'rewrite')} waiting for you`
  if (b.gaps.unanswered > 0) return `${plural(b.gaps.unanswered, 'gap')} left to look at`
  return 'Ready to send'
}
