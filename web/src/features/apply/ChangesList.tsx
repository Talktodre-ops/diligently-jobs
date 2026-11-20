import { isApiError } from '../../api/client'
import { plural } from './format'
import { decisionWord, type ReviewItem } from './reviewItems'
import { useDecide } from './useDecide'
import s from './ChangesList.module.css'

type Props = { appId: string; items: ReviewItem[]; onEdit: (itemId: string) => void }

/** Desktop: every suggestion beside the CV, decided where it stands. */
export function ChangesList({ appId, items, onEdit }: Props) {
  const decide = useDecide(appId)
  const notSeen = items.filter((i) => i.status === 'pending').length
  const inCv = items.filter((i) => i.status !== 'kept').length

  return (
    <section aria-labelledby="changes-title" className={s.wrap}>
      <div className={s.head}>
        <h2 id="changes-title" className={s.title}>
          {items.length === 0 ? 'No changes suggested' : `${plural(inCv, 'change')} in your CV`}
        </h2>
        {notSeen > 0 && <span className={s.count}>{notSeen} not looked at</span>}
      </div>
      {items.length === 0 && <p className={s.quiet}>Your CV already reads well for this job.</p>}
      <ul className={s.items}>
        {items.map((item) => {
          const busy = decide.busyId === item.id
          const error = decide.errorFor === item.id && decide.error
            ? isApiError(decide.error) ? decide.error.message : 'That did not save. Try again.'
            : null
          const kept = item.status === 'kept'
          return (
            <li key={item.id} className={s.item} aria-label={item.where}>
              <div className={s.top}>
                <span className={s.where}>{item.where}</span>
                <span className={item.status === 'pending' ? s.statusNew : s.status}>{decisionWord(item.status)}</span>
              </div>
              <p className={kept ? s.text : s.struck}><span className="visually-hidden">Original: </span>{item.original || 'No summary yet'}</p>
              <p className={kept ? s.struck : s.inCv}><span className="visually-hidden">Suggestion: </span>{item.rewrite}</p>
              <div className={s.actions}>
                {kept ? (
                  <button type="button" className={s.link} disabled={decide.busy} aria-busy={busy || undefined}
                    onClick={() => decide.decide(item, { action: 'accept' })}>Use the suggestion</button>
                ) : (
                  <>
                    <button type="button" className={s.link} disabled={decide.busy} aria-busy={busy || undefined}
                      onClick={() => decide.decide(item, { action: 'keep' })}>Keep original</button>
                    <button type="button" className={s.link} disabled={decide.busy} onClick={() => onEdit(item.id)}>Edit</button>
                    {item.status === 'pending' && (
                      <button type="button" className={s.link} disabled={decide.busy} aria-busy={busy || undefined}
                        onClick={() => decide.decide(item, { action: 'accept' })}>Looks good</button>
                    )}
                  </>
                )}
              </div>
              {error && <p className={s.error} role="alert">{error}</p>}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
