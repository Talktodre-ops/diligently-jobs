import { matchWord } from '../../ui/ScoreBar'
import { Icon } from '../../ui/Icon'
import type { Score } from './api'
import s from './ScoreCard.module.css'

/** Before and now, on Aubergine. `now` moves as the user accepts suggestions. */
export function ScoreCard({ score, status, compact }: { score: Score; status: string; compact?: boolean }) {
  const { before, current } = score
  if (current == null) {
    return (
      <section aria-label="Match score" className={s.card}>
        <div className={s.status}>{status}</div>
        <p className={s.unscored}>This job has not been scored yet.</p>
      </section>
    )
  }
  const pct = Math.max(0, Math.min(100, current))
  return (
    <section aria-label="Match score" className={[s.card, compact && s.compact].filter(Boolean).join(' ')}>
      <div className={s.status}>{status}</div>
      <div className={s.numbers}>
        {before != null && (
          <>
            <div className={s.col}>
              <div className={s.small}>Before</div>
              <div className={s.before}>{before}</div>
            </div>
            <Icon name="arrowRight" size={28} strokeWidth={2.2} className={s.arrow} />
          </>
        )}
        <div className={s.col}>
          <div className={s.small}>Now</div>
          <div className={s.now} role="status" aria-live="polite">{current}</div>
        </div>
        <div className={s.band}>{matchWord(current)}</div>
      </div>
      <div className={s.track} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={current} aria-label={`Match ${current} out of 100`}>
        <div className={s.fill} style={{ width: `${pct}%` }} />
      </div>
      {score.projected != null && score.projected > current && (
        <div className={s.small}>Up to {score.projected} if you use every rewrite</div>
      )}
      {score.rescored != null && <div className={s.small}>Last full re-score: {score.rescored}</div>}
    </section>
  )
}
