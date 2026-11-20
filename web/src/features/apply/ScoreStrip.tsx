import { Icon } from '../../ui/Icon'
import { matchWord } from '../../ui/ScoreBar'
import type { Score } from './api'
import s from './ScoreStrip.module.css'

/** Match before and now on one Aubergine line. `now` moves as suggestions stay in or come out. */
export function ScoreStrip({ score }: { score: Score }) {
  const { before, current } = score
  if (current == null) return null
  return (
    <section aria-label="Match score" className={s.strip}>
      <span className={s.label}>Match</span>
      {before != null && before !== current && (
        <>
          <span className={s.before}><span className="visually-hidden">Before </span>{before}</span>
          <Icon name="arrowRight" size={18} strokeWidth={2.2} className={s.arrow} />
        </>
      )}
      <span className={s.now}><span className="visually-hidden">Now </span><span role="status" aria-live="polite">{current}</span></span>
      <span className={s.band}>{matchWord(current)}</span>
    </section>
  )
}
