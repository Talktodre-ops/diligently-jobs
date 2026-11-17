import { useState } from 'react'
import { Link } from 'react-router'
import { dayLabel } from '../apply/format'
import type { WeekEvent } from './api'
import s from './HomePage.module.css'

const SHOWN = 6

/** What happened in the last seven days, newest first. Long weeks fold after SHOWN items. */
export function ThisWeek({ events, desktop }: { events: WeekEvent[]; desktop: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const folds = events.length > SHOWN
  const visible = folds && !expanded ? events.slice(0, SHOWN) : events
  return (
    <section aria-labelledby="this-week" className={s.section}>
      <div className={s.sectionHead}>
        <h2 id="this-week" className={s.h2}>This week</h2>
        {!desktop && <Link to="/jobs" className={s.headLink}>All jobs</Link>}
      </div>
      {events.length === 0 ? (
        <p className={s.quiet}>Nothing yet this week. Applications you tailor and send show up here.</p>
      ) : (
        <ol id="this-week-list" className={desktop ? s.weekBox : s.timeline}>
          {visible.map((e, i) => {
            const meta = [dayLabel(e.at), e.role].filter(Boolean).join(' · ')
            const body = (
              <>
                <span className={s.rail} aria-hidden="true">
                  <span className={i === 0 ? s.dotNow : s.dot} />
                  {!desktop && i < visible.length - 1 && <span className={s.line} />}
                </span>
                <span className={s.eventText}>
                  <span className={s.eventTitle}>{e.text}</span>
                  <span className={s.eventMeta}>{meta}</span>
                </span>
              </>
            )
            return (
              <li key={`${e.at}-${i}`} className={s.event}>
                {e.application_id ? (
                  <Link to={`/applications/${e.application_id}`} className={s.eventLink}>{body}</Link>
                ) : (
                  <div className={s.eventLink}>{body}</div>
                )}
              </li>
            )
          })}
        </ol>
      )}
      {folds && (
        <button type="button" className={s.seeAll} aria-expanded={expanded} aria-controls="this-week-list" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show fewer' : `See all ${events.length}`}
        </button>
      )}
    </section>
  )
}
