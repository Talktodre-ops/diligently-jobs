import { useState } from 'react'
import { Link } from 'react-router'
import { PageState } from '../../ui/PageState'
import { useRewrites, useTailoredCv, type ResumeDoc, type Rewrites } from './api'
import { Switch } from '../../ui/Switch'
import s from './CvPaper.module.css'

/** A suggestion in the CV: looked at ('used') or not yet ('waiting'). Kept originals carry no mark. */
type Mark = { kind: 'used' | 'waiting'; id: string } | null

/** "E2.B3" to [1, 2]: the experience entry and bullet a rewrite belongs to. */
function parseBulletId(id: string | null): [number, number] | null {
  const m = id?.match(/^E(\d+)\.B(\d+)$/)
  return m ? [Number(m[1]) - 1, Number(m[2]) - 1] : null
}

function marks(data: Rewrites | undefined) {
  const bullets = new Map<string, Mark>()
  for (const r of data?.rewrites ?? []) {
    const at = parseBulletId(r.bullet_id)
    if (!at) continue
    bullets.set(at.join('.'), r.status === 'kept' ? null : { kind: r.status === 'pending' ? 'waiting' : 'used', id: r.id })
  }
  const sum = data?.summary
  const summary: Mark = !sum || sum.status === 'kept' ? null : { kind: sum.status === 'pending' ? 'waiting' : 'used', id: 'summary' }
  return { bullets, summary }
}

/**
 * The tailored CV as it would go out, set like the page the recruiter gets.
 * Butter marks a suggestion in use; a dashed outline marks one in use but not
 * looked at yet. With `changeSearch`, each marked line links to its
 * suggestion at that address, and wraps like the text around it.
 */
export function CvPaper({ id, changeSearch }: { id: string; changeSearch?: (itemId: string) => string }) {
  const cv = useTailoredCv(id)
  const rewrites = useRewrites(id)
  const [show, setShow] = useState(true)

  if (cv.isPending) return <section className={s.wrap} aria-label="Tailored CV"><PageState.Loading label="Loading your CV" /></section>
  if (cv.isError) return <section className={s.wrap} aria-label="Tailored CV"><PageState.Error error={cv.error} onRetry={() => cv.refetch()} /></section>

  const m = marks(rewrites.data)
  const marked = (mark: Mark, text: string) => {
    if (!show || !mark) return text
    if (!changeSearch) return <span className={s[mark.kind]}>{text}</span>
    return (
      <Link to={{ search: changeSearch(mark.id) }} replace className={`${s.markLink} ${s[mark.kind]}`}>
        {text}
        <span className="visually-hidden">{mark.kind === 'waiting' ? ' (changed for this job, not looked at yet)' : ' (changed for this job)'}</span>
      </Link>
    )
  }
  const doc: ResumeDoc = cv.data.doc
  const contact = [doc.header.email, doc.header.phone, doc.header.linkedin?.display, doc.header.github?.display, doc.header.website?.display].filter(Boolean)

  return (
    <section aria-labelledby="cv-heading" className={s.wrap}>
      <div className={s.bar}>
        <h2 id="cv-heading" className={s.caption}>
          Your tailored CV · {cv.data.paper_size === 'letter' ? 'US Letter' : 'A4'} · as it stands now
        </h2>
        <label className={s.toggle}>
          Show changes
          <Switch checked={show} onChange={setShow} label="Show changes" />
        </label>
      </div>
      {show && (
        <p className={s.legend}>
          <span className={s.used}>Changed for this job</span> <span className={s.waiting}>Not looked at yet</span>
        </p>
      )}
      <article className={s.paper} aria-label="Your tailored CV">
        <header className={s.docHead}>
          <div className={s.name}>{doc.header.name}</div>
          {doc.header.title && <div className={s.title}>{doc.header.title}</div>}
          {contact.length > 0 && <div className={s.contact}>{contact.join(' · ')}</div>}
        </header>

        {doc.summary && (
          <>
            <h3 className={s.section}>Professional Summary</h3>
            <p className={s.p}>{marked(m.summary, doc.summary)}</p>
          </>
        )}

        {doc.experience.length > 0 && <h3 className={s.section}>Experience</h3>}
        {doc.experience.map((e, ei) => (
          <div key={ei} className={s.entry}>
            <div className={s.line}><strong>{e.company}</strong><span>{[e.start, e.end].filter(Boolean).join(' to ')}</span></div>
            <div className={s.lineItalic}><span>{e.role}</span><span>{e.location}</span></div>
            <ul className={s.bullets}>
              {e.bullets.map((b, bi) => (
                <li key={bi}>{marked(m.bullets.get(`${ei}.${bi}`) ?? null, b)}</li>
              ))}
            </ul>
          </div>
        ))}

        {doc.education.length > 0 && <h3 className={s.section}>Education</h3>}
        {doc.education.map((e, i) => (
          <div key={i} className={s.entry}>
            <div className={s.line}><strong>{e.institution}</strong><span>{[e.start, e.end].filter(Boolean).join(' to ')}</span></div>
            {e.degree && <div className={s.lineItalic}><span>{e.degree}</span><span>{e.location}</span></div>}
          </div>
        ))}

        {doc.skills.length > 0 && (
          <>
            <h3 className={s.section}>Skills</h3>
            <p className={s.p}>
              {doc.skills.map((g, i) => (
                <span key={i}><strong>{g.label}:</strong> {g.items.join(', ')}. </span>
              ))}
            </p>
          </>
        )}

        {(doc.projects?.length ?? 0) > 0 && (
          <>
            <h3 className={s.section}>Projects</h3>
            <ul className={s.bullets}>
              {doc.projects!.map((p, i) => (
                <li key={i}>{p.name ? <strong>{p.name}: </strong> : null}{p.description}</li>
              ))}
            </ul>
          </>
        )}
      </article>
    </section>
  )
}
