import type { UseQueryResult } from '@tanstack/react-query'
import { Link } from 'react-router'
import { companyName } from '../apply/api'
import type { ApplicationListItem, NeedsYouCard, Stage } from './api'
import s from './HomePage.module.css'

const columns: { stage: Stage; label: string }[] = [
  { stage: 'saved', label: 'Drafting' },
  { stage: 'applied', label: 'Applied' },
  { stage: 'interviewing', label: 'Interview' },
]
const SHOWN = 4

/** Desktop only: where every live application stands, by stage. */
export function Pipeline({ apps, cards }: { apps: UseQueryResult<ApplicationListItem[]>; cards: NeedsYouCard[] }) {
  const dueFollowUp = new Set(cards.filter((c) => c.type === 'follow_up').map((c) => c.application_id))
  const offers = apps.data?.filter((a) => a.stage === 'offer') ?? []
  const shown = offers.length > 0 ? [...columns, { stage: 'offer' as const, label: 'Offer' }] : columns
  return (
    <section aria-labelledby="pipeline" className={s.pipeline}>
      <div className={s.sectionHead}>
        <h2 id="pipeline" className={s.h2}>Pipeline</h2>
        <Link to="/jobs" className={s.headLink}>All jobs</Link>
      </div>
      {apps.isError ? (
        <p className={s.quiet}>The pipeline did not load. <button type="button" className={s.textButton} onClick={() => apps.refetch()}>Try again</button></p>
      ) : (
        <div className={s.stages}>
          {shown.map((col) => {
            const items = apps.data?.filter((a) => a.stage === col.stage) ?? []
            return (
              <div key={col.stage} className={s.stage}>
                <div className={s.stageHead}>
                  <span>{col.label}</span>
                  <span className={s.stageCount}>{apps.isPending ? '' : items.length}</span>
                </div>
                {items.length === 0 && !apps.isPending && <p className={s.stageEmpty}>None yet</p>}
                {items.slice(0, SHOWN).map((a) => {
                  const due = dueFollowUp.has(a.id)
                  const cls = col.stage === 'interviewing' ? s.chipDark : due ? s.chipButter : s.chip
                  return (
                    <Link key={a.id} to={`/applications/${a.id}`} className={cls}>
                      <span className={s.chipTitle}>{companyName(a.company)}</span>
                      <span className={s.chipSub}>{due ? 'Follow up today' : col.stage === 'interviewing' ? 'Prepare' : a.role ?? 'Reading the job'}</span>
                    </Link>
                  )
                })}
                {items.length > SHOWN && (
                  <Link to="/jobs" className={s.more}>{items.length - SHOWN} more</Link>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
