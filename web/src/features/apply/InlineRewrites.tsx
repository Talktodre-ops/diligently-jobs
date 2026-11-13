import { useState } from 'react'
import { Link } from 'react-router'
import { isApiError } from '../../api/client'
import { Button } from '../../ui/Button'
import { useRewrites } from './api'
import { decisionWord, reviewItems, type ReviewItem } from './reviewItems'
import { useDecide } from './useDecide'
import surface from './onSurface.module.css'
import s from './InlineRewrites.module.css'

/** Desktop Workspace: decide on each suggestion beside the rendered CV. */
export function InlineRewrites({ id }: { id: string }) {
  const rewrites = useRewrites(id)
  const decide = useDecide(id)
  const [reopened, setReopened] = useState<Set<string>>(new Set())

  if (rewrites.isPending) return <section className={s.box} aria-busy="true"><p className={s.quiet}>Loading rewrites</p></section>
  if (rewrites.isError) {
    return (
      <section className={s.box}>
        <p className={s.quiet}>Rewrites did not load. <button type="button" className={s.link} onClick={() => rewrites.refetch()}>Try again</button></p>
      </section>
    )
  }
  const items = reviewItems(rewrites.data)
  const waiting = items.filter((i) => i.status === 'pending').length
  const open = (i: ReviewItem) => i.status === 'pending' || reopened.has(i.id)
  const close = (itemId: string) => setReopened((prev) => { const n = new Set(prev); n.delete(itemId); return n })

  return (
    <section aria-labelledby="inline-rewrites" className={s.box}>
      <div className={s.head}>
        <h2 id="inline-rewrites" className={s.h2}>
          {items.length === 0 ? 'No changes suggested' : waiting === 0 ? 'All rewrites reviewed' : `${waiting} ${waiting === 1 ? 'rewrite needs' : 'rewrites need'} you`}
        </h2>
        {items.length > 0 && <Link to={`/applications/${id}/review`} className={s.headLink}>One at a time</Link>}
      </div>
      {items.length === 0 && <p className={s.quiet}>Your CV already reads well for this job.</p>}
      <ul className={s.items}>
        {items.map((item) => (
          <li key={item.id} className={open(item) ? s.item : s.itemDone}>
            <div className={s.where}>{item.where}</div>
            {open(item) ? (
              <>
                <p className={s.original}><span className="visually-hidden">Original: </span>{item.original || 'No summary yet'}</p>
                <p className={s.rewrite}><span className="visually-hidden">Rewrite: </span>{item.rewrite}</p>
                {decide.errorFor === item.id && decide.error && (
                  <p className={s.error} role="alert">{isApiError(decide.error) ? decide.error.message : 'That did not save. Try again.'}</p>
                )}
                <div className={s.buttons}>
                  <Button variant="secondary" small busy={decide.busyId === item.id} disabled={decide.busy}
                    onClick={() => decide.decide(item, { action: 'keep' }, () => close(item.id))}>
                    Keep original
                  </Button>
                  <Button variant="dark" className={surface.solid} small disabled={decide.busy}
                    onClick={() => decide.decide(item, { action: 'accept' }, () => close(item.id))}>
                    Use rewrite
                  </Button>
                </div>
                <Link to={`/applications/${id}/review?item=${item.id}`} className={s.editLink}>Edit the wording</Link>
              </>
            ) : (
              <div className={s.decided}>
                <span className={s.result}>{decisionWord(item.status)}</span>
                <button type="button" className={s.link} onClick={() => setReopened((prev) => new Set(prev).add(item.id))}
                  aria-label={`Change your choice for ${item.where}`}>
                  Change
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
