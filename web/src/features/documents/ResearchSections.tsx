import type { Cited, ResearchBrief, Source } from './api'
import { hostOf } from './format'
import { Icon } from '../../ui/Icon'
import s from './Research.module.css'

const sourceOf = (sources: Source[], c: Cited) => sources[c.source - 1]

function month(iso?: string | null) {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
}

export function OverviewSection({ brief, rest, sources }: { brief: ResearchBrief; rest: string; sources: Source[] }) {
  return (
    <>
      {rest && <p className={s.lead}>{rest}</p>}
      {brief.products.length > 0 && (
        <section className={s.section} aria-labelledby="r-products">
          <h2 id="r-products" className={s.label}>What they make</h2>
          <ul className={s.chips}>
            {brief.products.map((p) => <li key={p} className={s.chip}>{p}</li>)}
          </ul>
        </section>
      )}
      {brief.culture.length > 0 && (
        <section className={s.section} aria-labelledby="r-culture">
          <h2 id="r-culture" className={s.label}>What they care about</h2>
          <ul className={s.card}>
            {brief.culture.map((c) => <li key={c} className={s.row}>{c}</li>)}
          </ul>
        </section>
      )}
      {brief.recent_news.length > 0 && (
        <section className={s.section} aria-labelledby="r-recent">
          <h2 id="r-recent" className={s.label}>Recent</h2>
          {brief.recent_news.map((n) => {
            const src = sourceOf(sources, n)
            const meta = [src && hostOf(src.url), month(src?.published)].filter(Boolean).join(' · ')
            return src ? (
              <a key={n.text} className={s.news} href={src.url} target="_blank" rel="noopener noreferrer">
                <span className={s.newsTitle}>{n.text}</span>
                <span className={s.meta}>{meta}<span className="visually-hidden"> (opens in a new tab)</span></span>
              </a>
            ) : (
              <div key={n.text} className={s.news}><span className={s.newsTitle}>{n.text}</span></div>
            )
          })}
        </section>
      )}
      {brief.why_them && (
        <section className={s.section} aria-labelledby="r-why">
          <h2 id="r-why" className={s.label}>Why them</h2>
          <p className={s.why}>{brief.why_them}</p>
        </section>
      )}
    </>
  )
}

export function TalkingPoints({ points, sources, company }: { points: Cited[]; sources: Source[]; company: string }) {
  if (points.length === 0) {
    return <p className={s.intro}>No talking points came out of the sources. Try searching again, or read the sources yourself.</p>
  }
  return (
    <>
      <p className={s.intro}>Things worth raising with {company}, in your letter and in the interview. Each one comes from a source you can check.</p>
      <ol className={s.points}>
        {points.map((p, i) => {
          const src = sourceOf(sources, p)
          return (
            <li key={p.text} className={s.point}>
              <span className={s.pointNo} aria-hidden="true">{i + 1}</span>
              <div className={s.pointBody}>
                <p className={s.pointText}>{p.text}</p>
                {src && (
                  <a className={s.pointSource} href={src.url} target="_blank" rel="noopener noreferrer">
                    Source: {src.title}<span className="visually-hidden"> (opens in a new tab)</span>
                  </a>
                )}
              </div>
            </li>
          )
        })}
      </ol>
    </>
  )
}

export function SourceList({ sources }: { sources: Source[] }) {
  if (sources.length === 0) return <p className={s.intro}>No sources yet.</p>
  return (
    <>
      <p className={s.intro}>Everything here comes from these pages. Open one to check it yourself.</p>
      <ul className={s.card}>
        {sources.map((src) => (
          <li key={src.url}>
            <a className={s.source} href={src.url} target="_blank" rel="noopener noreferrer">
              <span className={s.sourceText}>
                <span className={s.sourceTitle}>{src.title}</span>
                <span className={s.meta}>{hostOf(src.url)}</span>
              </span>
              <Icon name="link" size={16} className={s.sourceIcon} />
              <span className="visually-hidden"> (opens in a new tab)</span>
            </a>
          </li>
        ))}
      </ul>
    </>
  )
}
