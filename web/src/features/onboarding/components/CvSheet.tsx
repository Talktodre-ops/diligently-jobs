import { useEffect, useRef, type ReactNode } from 'react'
import type { ResumeDoc } from '../api'
import s from './CvSheet.module.css'

export type CvMarks = {
  /** Issue paths from the API, e.g. "experience[1]" or "header.title". */
  fix?: string[]
  /** The bullet being strengthened, as "role.bullet" indexes, e.g. "0.1". */
  strengthen?: string | null
  /** Bullets the user added a number to, same keys. */
  added?: string[]
}

type Props = {
  doc: ResumeDoc | null
  /** How many of the four blocks to show (header, latest role, earlier roles, skills and education). Omit for all. */
  reveal?: number
  marks?: CvMarks
  /** Show the colour key under the CV (the Check screen). */
  legend?: boolean
  /** Shown on the paper while there is no CV yet. */
  empty?: ReactNode
  /** Desktop pane: the paper stays in view and scrolls on its own. */
  contained?: boolean
  /** Blocks rise into place as they appear (the reveal after a read). */
  animate?: boolean
}

function Flag({ kind, children }: { kind: 'fix' | 'strong' | 'added'; children: ReactNode }) {
  const said = kind === 'fix' ? 'needs fixing' : kind === 'strong' ? 'being strengthened' : 'added by you'
  return (
    <mark className={s[kind]} data-mark={kind}>
      {children}
      <span className="visually-hidden"> ({said})</span>
    </mark>
  )
}

/**
 * The master CV as a page of paper, in the document typeface. Used on the
 * desktop right pane (filling in while it is read, marking lines on Check) and
 * behind "See your whole CV" on a phone.
 */
export function CvSheet({ doc, reveal = 4, marks, legend, empty, contained, animate }: Props) {
  const paper = useRef<HTMLDivElement>(null)
  const fix = new Set(marks?.fix ?? [])
  const added = new Set(marks?.added ?? [])
  const strengthen = marks?.strengthen ?? null

  // Keep the line being worked on in view inside the paper (it scrolls on its own on a desktop).
  const fixCount = marks?.fix?.length ?? 0
  useEffect(() => {
    const box = paper.current
    const el = box?.querySelector<HTMLElement>('[data-mark="strong"], [data-mark="fix"]')
    if (!contained || !box || !el || box.scrollHeight <= box.clientHeight || typeof box.scrollTo !== 'function') return
    const top = el.offsetTop
    if (top < box.scrollTop + 40 || top > box.scrollTop + box.clientHeight - 80) box.scrollTo({ top: Math.max(0, top - 120), behavior: 'smooth' })
  }, [strengthen, fixCount, contained])

  const cls = [s.paper, contained && s.contained].filter(Boolean).join(' ')
  const rise = animate ? s.rise : ''
  const scrollProps = contained ? { tabIndex: 0, role: 'region', 'aria-label': 'Your CV' } : {}

  if (!doc) {
    return (
      <div className={`${cls} ${s.blank}`} ref={paper}>
        {empty}
      </div>
    )
  }

  const h = doc.header
  const contact: ReactNode[] = []
  if (h.title?.trim()) contact.push(h.title)
  else if (fix.has('header.title')) contact.push(<Flag kind="fix">Headline missing</Flag>)
  if (h.email?.trim()) contact.push(h.email)
  else if (fix.has('header.email')) contact.push(<Flag kind="fix">Email missing</Flag>)
  if (h.phone?.trim()) contact.push(h.phone)

  const roles = doc.experience
  const skills = doc.skills.flatMap((g) => g.items).filter(Boolean)

  const role = (i: number) => {
    const e = roles[i]!
    const dates = e.start?.trim() && e.end?.trim() ? `${e.start} to ${e.end}` : (e.start || e.end || '').trim()
    const datesMissing = fix.has(`experience[${i}]`)
    return (
      <div key={i} className={s.entry}>
        <div className={s.entryHead}>
          <strong>{[e.company, e.role].filter((x) => x?.trim()).join(', ') || 'Role'}</strong>
          <span className={s.dates}>{datesMissing ? <Flag kind="fix">{dates || 'Dates missing'}</Flag> : dates}</span>
        </div>
        {e.bullets.length > 0 ? (
          <ul className={s.bullets}>
            {e.bullets.map((b, j) => {
              const key = `${i}.${j}`
              return (
                <li key={j}>
                  {added.has(key) ? <Flag kind="added">{b}</Flag> : strengthen === key ? <Flag kind="strong">{b}</Flag> : b}
                </li>
              )
            })}
          </ul>
        ) : fix.has(`experience[${i}].bullets`) ? (
          <ul className={s.bullets}><li><Flag kind="fix">Nothing listed for this role yet</Flag></li></ul>
        ) : null}
      </div>
    )
  }

  return (
    <div className={cls} ref={paper} {...scrollProps}>
      <div className={`${s.head} ${rise}`}>
        <div className={s.name}>{h.name || 'Your name'}</div>
        {contact.length > 0 && (
          <div className={s.contact}>
            {contact.map((c, i) => <span key={i}>{c}</span>)}
          </div>
        )}
      </div>

      {reveal >= 2 && (
        <section className={`${s.block} ${rise}`}>
          <h3 className={s.label}>Experience</h3>
          {roles.length > 0 ? role(0) : fix.has('experience') ? <p className={s.line}><Flag kind="fix">No roles yet</Flag></p> : <p className={s.muted}>No roles yet</p>}
        </section>
      )}

      {reveal >= 3 && roles.length > 1 && (
        <section className={`${s.block} ${rise}`} aria-label="Earlier roles">
          {roles.slice(1).map((_, k) => role(k + 1))}
        </section>
      )}

      {reveal >= 4 && (
        <>
          <section className={`${s.block} ${rise}`}>
            <h3 className={s.label}>Skills</h3>
            {skills.length > 0 ? <p className={s.line}>{skills.join(', ')}</p> : fix.has('skills') ? <p className={s.line}><Flag kind="fix">Skills missing</Flag></p> : <p className={s.muted}>None listed</p>}
          </section>
          {doc.education.length > 0 && (
            <section className={`${s.block} ${rise}`}>
              <h3 className={s.label}>Education</h3>
              {doc.education.map((ed, i) => (
                <p key={i} className={s.line}>{[ed.institution, ed.degree].filter((x) => x?.trim()).join(', ')}</p>
              ))}
            </section>
          )}
        </>
      )}

      {legend && (
        <div className={s.legend} aria-hidden="true">
          <span><span className={`${s.swatch} ${s.fix}`} />Needs fixing</span>
          <span><span className={`${s.swatch} ${s.strong}`} />Being strengthened</span>
          <span><span className={`${s.swatch} ${s.added}`} />Added by you</span>
        </div>
      )}
    </div>
  )
}

/** What the empty paper says before there is a CV. */
export function CvEmpty({ title, body }: { title: string; body: string }) {
  return (
    <>
      <div className={s.emptyTitle}>{title}</div>
      <p className={s.emptyBody}>{body}</p>
    </>
  )
}
