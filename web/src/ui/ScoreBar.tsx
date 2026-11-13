import s from './ScoreBar.module.css'

/** Match band words. No traffic-light colours: the palette's yellow and
 *  persimmon would read as warning and error. */
export function matchWord(score: number) {
  if (score >= 80) return 'Strong match'
  if (score >= 65) return 'Good match'
  if (score >= 50) return 'Fair match'
  return 'Weak match'
}

type Props = { score: number; before?: number | null; meta?: string; label?: string }

/** Aubergine for where the CV started, Persimmon for the lift. */
export function ScoreBar({ score, before, meta, label }: Props) {
  const clamp = (n: number) => Math.max(0, Math.min(100, n))
  return (
    <div className={s.wrap}>
      <div className={s.row}>
        <span className={s.label}>{label ?? `${matchWord(score)} · ${score}`}</span>
        {meta && <span className={s.meta}>{meta}</span>}
      </div>
      <div
        className={s.track}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={score}
        aria-label={before != null ? `Match ${score}, up from ${before}` : `Match ${score}`}
      >
        <div className={s.after} style={{ width: `${clamp(score)}%` }} />
        {before != null && <div className={s.before} style={{ width: `${clamp(before)}%` }} />}
      </div>
    </div>
  )
}
