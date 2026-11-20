import s from './BrandArt.module.css'

/** Decorative stack of CV pages with a match badge. Hidden from assistive tech. */
export function BrandArt() {
  return (
    <div className={s.art} aria-hidden="true">
      <div className={s.back} />
      <div className={s.page}>
        <span className={`${s.bar} ${s.center}`} style={{ height: 9, width: '50%', background: '#1A1A1A' }} />
        <span className={`${s.bar} ${s.center}`} style={{ width: '70%', background: '#B9B0B5' }} />
        <span className={s.rule} />
        <span className={s.bar} style={{ width: '92%' }} />
        <span className={s.bar} style={{ width: '86%', height: 6, background: 'var(--butter)' }} />
        <span className={s.bar} style={{ width: '78%' }} />
        <span className={s.rule} />
        <span className={s.bar} style={{ width: '60%', background: '#B9B0B5' }} />
        <span className={s.bar} style={{ width: '94%', height: 6, background: 'var(--butter)' }} />
        <span className={s.bar} style={{ width: '88%' }} />
        <span className={s.bar} style={{ width: '70%' }} />
        <span className={s.bar} style={{ width: '80%', height: 6, background: 'var(--butter)' }} />
        <span className={s.bar} style={{ width: '90%' }} />
      </div>
      <div className={s.badge}>
        <span className={s.score}>86</span>
        <span className={s.word}>match</span>
      </div>
    </div>
  )
}
