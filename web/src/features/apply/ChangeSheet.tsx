import { useState } from 'react'
import { isApiError } from '../../api/client'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { Icon } from '../../ui/Icon'
import { TextArea } from '../../ui/TextField'
import { decisionWord, type ReviewItem } from './reviewItems'
import { useDecide } from './useDecide'
import surface from './onSurface.module.css'
import s from './ChangeSheet.module.css'

type Props = { appId: string; items: ReviewItem[]; startId: string; startEditing?: boolean; onClose: () => void }

/**
 * One suggestion at a time, over the CV: the original, what is in the CV for
 * this job, and why. Deciding moves on to the next one not looked at yet and
 * closes when none are left. Every suggestion is reachable with Previous and
 * Next, so a choice can be changed.
 */
export function ChangeSheet({ appId, items, startId, startEditing = false, onClose }: Props) {
  const decide = useDecide(appId)
  const [currentId, setCurrentId] = useState(startId)
  const [editing, setEditing] = useState(startEditing)
  const [draft, setDraft] = useState(() => items.find((i) => i.id === startId)?.rewrite ?? '')
  const [draftError, setDraftError] = useState<string | null>(null)

  const index = Math.max(0, items.findIndex((i) => i.id === currentId))
  const item = items[index]
  if (!item) return null

  function go(to: number) {
    const next = items[(to + items.length) % items.length]!
    setCurrentId(next.id)
    setEditing(false)
    setDraftError(null)
  }

  function afterDecision() {
    setEditing(false)
    setDraftError(null)
    // The next one not looked at, after this one; close when there is none.
    for (let step = 1; step < items.length; step++) {
      const next = items[(index + step) % items.length]!
      if (next.status === 'pending') return setCurrentId(next.id)
    }
    onClose()
  }

  function act(action: 'accept' | 'keep') {
    decide.decide(item!, { action }, afterDecision)
  }

  function startEdit() {
    setDraft(item!.rewrite)
    setDraftError(null)
    setEditing(true)
  }

  function save() {
    const text = draft.trim()
    if (!text) return setDraftError('Write the line you want, or cancel.')
    decide.decide(item!, { action: 'edit', text }, afterDecision)
  }

  const kept = item.status === 'kept'
  const error = decide.errorFor === item.id && decide.error
    ? isApiError(decide.error) ? decide.error.message : 'That did not save. Try again.'
    : null

  return (
    <Dialog title={item.where} onClose={onClose}>
      <div className={s.meta}>
        <span className={item.status === 'pending' ? s.statusNew : s.status}>{decisionWord(item.status)}</span>
        {items.length > 1 && <span className={s.position}>{index + 1} of {items.length}</span>}
      </div>

      <div className={s.block}>
        <div className={s.label}>Your original</div>
        <p className={kept ? s.text : s.struck}>{item.original || 'Your CV has no summary yet.'}</p>
      </div>

      <div className={s.block}>
        <div className={s.label}>{kept ? 'The suggestion' : 'In your CV for this job'}</div>
        {editing ? (
          <div className={s.edit}>
            <TextArea label="Edit the line" hideLabel value={draft} onChange={(e) => setDraft(e.target.value)} rows={4} error={draftError ?? error} autoFocus />
            <div className={s.row}>
              <Button variant="ghost" small onClick={() => setEditing(false)} disabled={decide.busy}>Cancel</Button>
              <Button small onClick={save} busy={decide.busy}>Save and use</Button>
            </div>
          </div>
        ) : (
          <p className={kept ? s.text : s.inCv}>{item.rewrite}</p>
        )}
      </div>

      {(item.why || item.needsNumber) && !editing && (
        <p className={item.needsNumber ? s.whyNumber : s.why}>
          <Icon name={item.needsNumber ? 'edit' : 'alert'} size={16} strokeWidth={1.8} className={s.whyIcon} />
          <span>
            {item.needsNumber && <strong>A number would make this stronger. </strong>}
            {item.why}
          </span>
        </p>
      )}

      {error && !editing && <p className={s.error} role="alert">{error}</p>}

      {!editing && (
        <div className={s.actions}>
          {kept ? (
            <Button block onClick={() => act('accept')} busy={decide.busy}>Use the suggestion</Button>
          ) : (
            <>
              <Button variant="secondary" onClick={() => act('keep')} disabled={decide.busy}>Keep original</Button>
              <Button variant="secondary" onClick={startEdit} disabled={decide.busy}>Edit</Button>
              {item.status === 'pending' && (
                <Button variant="dark" className={surface.solid} onClick={() => act('accept')} busy={decide.busy}>Looks good</Button>
              )}
            </>
          )}
        </div>
      )}

      {items.length > 1 && !editing && (
        <div className={s.nav}>
          <button type="button" className={s.navButton} onClick={() => go(index - 1)} disabled={decide.busy}>
            <Icon name="back" size={16} strokeWidth={2} /> Previous
          </button>
          <button type="button" className={s.navButton} onClick={() => go(index + 1)} disabled={decide.busy}>
            Next <Icon name="forward" size={16} strokeWidth={2} />
          </button>
        </div>
      )}
    </Dialog>
  )
}
