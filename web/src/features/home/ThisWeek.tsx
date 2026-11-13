import { Link } from 'react-router'
import { dayLabel } from '../apply/format'
import type { WeekEvent } from './api'
import s from './HomePage.module.css'

/** What happened in the last seven days, newest first. */
export function ThisWeek({ events, desktop }: { events: WeekEvent[]; desktop: boolean }) {
  return (
    <section aria-labelledby="this-week" className={s.section}>
      <div className={s.sectionHead}>
        <h2 id="this-week" className={s.h2}>This week</h2>
        {!desktop && <Link to="/jobs" className={s.headLink}>All jobs</Link>}
      </div>
      {events.length === 0 ? (
        <p className={s.quiet}>Nothing yet this week. Applications you tailor and send show up here.</p>
      ) : (
        <ol className={desktop ? s.weekBox : s.timeline}>
          {events.map((e, i) => {
            const meta = [dayLabel(e.at), e.role].filter(Boolean).join(' · ')
            const body = (
              <>
                <span className={s.rail} aria-hidden="true">
                  <span className={i === 0 ? s.dotNow : s.dot} />
                  {!desktop && i < events.length - 1 && <span className={s.line} />}
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
    </section>
  )
}
