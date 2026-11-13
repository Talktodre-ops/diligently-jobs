import type { ReactNode } from 'react'
import type { ResumeDoc } from '../apply/api'
import { dateRange } from './format'
import { isChanged } from './highlights'
import s from './ResumeRead.module.css'

type Link = { url: string; display: string } | null | undefined

function Mark({ on, children }: { on: boolean; children: ReactNode }) {
  return on ? <mark className={s.mark}>{children}</mark> : <>{children}</>
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={s.section}>
      <h2 className={s.label}>{title}</h2>
      {children}
    </section>
  )
}

/**
 * The tailored CV reflowed for reading on a phone: same content and order as
 * the PDF, set at a readable size. Changed text is marked.
 */
export function ResumeRead({ doc, changed }: { doc: ResumeDoc; changed: Set<string> }) {
  const h = doc.header
  const links = [h.linkedin, h.github, h.website].filter((l): l is NonNullable<Link> => !!l?.url)
  const contact = [h.email, h.phone].filter((c): c is string => !!c)
  return (
    <article className={s.doc} aria-label="Your tailored CV">
      <header className={s.head}>
        <p className={s.name}>{h.name}</p>
        {h.title && <p className={s.title}>{h.title}</p>}
        {(contact.length > 0 || links.length > 0) && (
          <p className={s.contact}>
            {contact.map((c) => <span key={c}>{c}</span>)}
            {links.map((l) => <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer">{l.display || l.url}</a>)}
          </p>
        )}
      </header>

      {doc.summary && (
        <Section title="Summary">
          <p className={s.text}><Mark on={isChanged(changed, doc.summary)}>{doc.summary}</Mark></p>
        </Section>
      )}

      {doc.experience.length > 0 && (
        <Section title="Experience">
          {doc.experience.map((e, i) => (
            <div key={`${e.company}-${i}`} className={s.entry}>
              <h3 className={s.entryHead}>{e.company}</h3>
              <p className={s.entryMeta}>{[e.role, dateRange(e.start, e.end), e.location].filter(Boolean).join(' · ')}</p>
              {e.bullets.length > 0 && (
                <ul className={s.bullets}>
                  {e.bullets.map((b, j) => <li key={j}><Mark on={isChanged(changed, b)}>{b}</Mark></li>)}
                </ul>
              )}
            </div>
          ))}
        </Section>
      )}

      {(doc.projects?.length ?? 0) > 0 && (
        <Section title="Projects">
          {doc.projects!.map((p, i) => (
            <div key={i} className={s.entry}>
              {p.name && <h3 className={s.entryHead}>{p.name}</h3>}
              <p className={s.text}>{p.description}</p>
              {p.link && <a className={s.small} href={p.link} target="_blank" rel="noopener noreferrer">{p.link}</a>}
            </div>
          ))}
        </Section>
      )}

      {doc.education.length > 0 && (
        <Section title="Education">
          {doc.education.map((ed, i) => (
            <div key={i} className={s.entry}>
              <h3 className={s.entryHead}>{ed.institution}</h3>
              <p className={s.entryMeta}>{[ed.degree, dateRange(ed.start, ed.end), ed.location].filter(Boolean).join(' · ')}</p>
            </div>
          ))}
        </Section>
      )}

      {doc.skills.length > 0 && (
        <Section title="Skills">
          <dl className={s.skills}>
            {doc.skills.map((g) => (
              <div key={g.label} className={s.skillRow}>
                <dt>{g.label}</dt>
                <dd>{g.items.join(', ')}</dd>
              </div>
            ))}
          </dl>
        </Section>
      )}
    </article>
  )
}
