import { useState } from 'react'
import { isApiError } from '../../api/client'
import { Button } from '../../ui/Button'
import { TextArea } from '../../ui/TextField'
import { useAnswerGap, useDecideGapBullet, type Gap } from './api'
import surface from './onSurface.module.css'
import s from './GapCard.module.css'

/** Handled means the user answered and, for "I have this", decided on the bullet. */
export function handled(g: Gap) {
  if (g.answer === 'dont') return true
  return g.answer === 'have' && (g.bullet_status === 'accepted' || g.bullet_status === 'discarded')
}

type Mode = 'auto' | 'choose' | 'write'

/** One requirement the CV does not fully show: answer it, and add the bullet we write from the answer. */
export function GapCard({ appId, gap, roles }: { appId: string; gap: Gap; roles: string[] }) {
  const answer = useAnswerGap(appId)
  const decide = useDecideGapBullet(appId)
  const [mode, setMode] = useState<Mode>('auto')
  const [text, setText] = useState(gap.answer === 'have' ? (gap.answer_text ?? '') : '')
  const [entry, setEntry] = useState(gap.target_entry ?? 0)
  const [note, setNote] = useState<string | null>(null)

  const required = gap.importance === 'required'
  const fieldId = `gap-${gap.id}`
  const err = (e: unknown) => (isApiError(e) ? e.message : 'That did not work. Try again.')
  const textError = answer.isError && isApiError(answer.error) && answer.error.field === 'text' ? answer.error.message : null
  const entryError = answer.isError && isApiError(answer.error) && answer.error.field === 'entry' ? answer.error.message : null
  const otherError = answer.isError && !textError && !entryError ? err(answer.error) : decide.isError ? err(decide.error) : null

  // What to show: the user's local choice wins, otherwise the saved state.
  const view: 'choose' | 'write' | 'suggested' | 'added' | 'left' | 'noBullet' | 'dont' =
    mode === 'write' ? 'write'
      : mode === 'choose' || gap.answer === null ? 'choose'
        : gap.answer === 'dont' ? 'dont'
          : !gap.suggested_bullet ? 'noBullet'
            : gap.bullet_status === 'accepted' ? 'added'
              : gap.bullet_status === 'discarded' ? 'left'
                : 'suggested'

  function submitHave() {
    setNote(null)
    if (text.trim().length < 15) {
      answer.reset()
      return setNote('Say a little more: where you did this and what you did.')
    }
    answer.mutate(
      { gapId: gap.id, answer: { have: true, text: text.trim(), entry } },
      { onSuccess: (r) => { setMode('auto'); setNote(r.note ?? null) } },
    )
  }

  function submitDont() {
    setNote(null)
    answer.mutate({ gapId: gap.id, answer: { have: false } }, { onSuccess: () => setMode('auto') })
  }

  return (
    <section aria-labelledby={`${fieldId}-name`} className={s.card}>
      <div className={s.top}>
        <div className={s.topText}>
          <h3 id={`${fieldId}-name`} className={s.name}>{gap.requirement}</h3>
          <div className={s.weight}>
            {required ? 'Required' : 'Nice to have'} · {gap.status === 'partial' ? 'partly shown on your CV' : 'not on your CV'}
          </div>
        </div>
        <span className={required ? s.tagBig : s.tag}>{required ? 'Big effect' : 'Small effect'}</span>
      </div>
      {gap.ask && <p className={s.ask}>{gap.ask}</p>}

      {view === 'choose' && (
        <div className={s.choices}>
          <Button variant="dark" className={surface.solid} small disabled={answer.isPending} onClick={() => setMode('write')}>I have this</Button>
          <Button variant="secondary" small busy={answer.isPending} onClick={submitDont}>I don't</Button>
        </div>
      )}

      {view === 'write' && (
        <div className={s.write}>
          <TextArea
            id={fieldId}
            label="Where did you use it?"
            placeholder="Say where, what you did and, if you can, a number. We write the bullet from your words only."
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            error={textError ?? note}
            autoFocus
          />
          {roles.length > 1 && (
            <div className={s.roleField}>
              <label htmlFor={`${fieldId}-role`} className={s.roleLabel}>Which role was it?</label>
              <select id={`${fieldId}-role`} className={s.select} value={entry} onChange={(e) => setEntry(Number(e.target.value))}
                aria-invalid={entryError ? true : undefined}>
                {roles.map((r, i) => <option key={i} value={i}>{r}</option>)}
              </select>
              {entryError && <span className={s.fieldError} role="alert">{entryError}</span>}
            </div>
          )}
          <div className={s.writeButtons}>
            <Button variant="ghost" small disabled={answer.isPending} onClick={() => { setMode('auto'); setNote(null); answer.reset() }}>Cancel</Button>
            <Button small busy={answer.isPending} onClick={submitHave}>{answer.isPending ? 'Writing' : 'Write a bullet'}</Button>
          </div>
        </div>
      )}

      {view === 'suggested' && (
        <div className={s.suggested}>
          <div className={s.boxLabel}>Suggested bullet</div>
          <p className={s.bullet}>{gap.suggested_bullet}</p>
          <p className={s.boxHint}>Not on your CV yet. Add it if it is accurate.</p>
          <div className={s.choices}>
            <Button variant="dark" small busy={decide.isPending && decide.variables?.bullet === 'accept'} disabled={decide.isPending}
              onClick={() => decide.mutate({ gapId: gap.id, bullet: 'accept' })}>
              Add to this CV
            </Button>
            <Button variant="secondary" small busy={decide.isPending && decide.variables?.bullet === 'discard'} disabled={decide.isPending}
              onClick={() => decide.mutate({ gapId: gap.id, bullet: 'discard' })}>
              Leave it out
            </Button>
          </div>
          <button type="button" className={s.textLink} onClick={() => setMode('write')}>Change what I said</button>
        </div>
      )}

      {view === 'added' && (
        <div className={s.added}>
          <div className={s.boxLabel}>Added to this CV</div>
          <p className={s.bullet}>{gap.suggested_bullet}</p>
          <button type="button" className={s.textLinkDark} disabled={decide.isPending}
            onClick={() => decide.mutate({ gapId: gap.id, bullet: 'discard' })}>
            Undo
          </button>
        </div>
      )}

      {view === 'left' && (
        <div className={s.left}>
          <p className={s.leftText}>You left the suggested bullet out. Your CV is unchanged.</p>
          <div className={s.linkRow}>
            <button type="button" className={s.textLinkDark} disabled={decide.isPending}
              onClick={() => decide.mutate({ gapId: gap.id, bullet: 'accept' })}>
              Add it after all
            </button>
            <button type="button" className={s.textLinkDark} onClick={() => setMode('choose')}>Change my answer</button>
          </div>
        </div>
      )}

      {view === 'noBullet' && (
        <div className={s.left}>
          <p className={s.leftText}>{note ?? 'That does not show the requirement yet. Add where you used it and what you did.'}</p>
          <button type="button" className={s.textLinkDark} onClick={() => setMode('write')}>Add more detail</button>
        </div>
      )}

      {view === 'dont' && (
        <div className={s.left}>
          <p className={s.leftText}>Left out of your CV. A redrafted cover letter will not claim it either.</p>
          <button type="button" className={s.textLinkDark} onClick={() => setMode('choose')}>Change my answer</button>
        </div>
      )}

      {otherError && <p className={s.fieldError} role="alert">{otherError}</p>}
    </section>
  )
}
