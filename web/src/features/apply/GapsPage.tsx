import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { isApiError } from '../../api/client'
import { Button, ButtonLink } from '../../ui/Button'
import { PageState } from '../../ui/PageState'
import { TextArea } from '../../ui/TextField'
import { TopBar } from '../../ui/TopBar'
import { companyName, useAnswerGap, useBrief, useDecideGapBullet, useGaps, useTailoredCv, type Gap } from './api'
import { countWord } from './format'
import surface from './onSurface.module.css'
import s from './GapsPage.module.css'

/** Handled means the user answered and, for "I have this", decided on the bullet. */
function handled(g: Gap) {
  if (g.answer === 'dont') return true
  return g.answer === 'have' && (g.bullet_status === 'accepted' || g.bullet_status === 'discarded')
}

export default function GapsPage() {
  const { id = '' } = useParams()
  const brief = useBrief(id)
  const gaps = useGaps(id)
  const cv = useTailoredCv(id)
  const back = `/applications/${id}`

  const header = (
    <TopBar back={back} backLabel="Back to application" eyebrow={companyName(brief.data?.application.company)} title="Gaps" />
  )
  if (gaps.isPending) return <PageState.Loading />
  if (gaps.isError) return <div className={s.page}>{header}<PageState.Error error={gaps.error} onRetry={() => gaps.refetch()} /></div>

  const open = gaps.data.gaps.filter((g) => g.status !== 'covered')
  const left = open.filter((g) => !handled(g)).length
  const roles = (cv.data?.doc.experience ?? []).map((e) => `${e.role} at ${e.company}`)

  if (open.length === 0) {
    return (
      <div className={s.page}>
        {header}
        <PageState.Empty
          title="No gaps"
          body="Your CV already shows everything this job asks for."
          action={<Link to={back}>Back to application</Link>}
        />
      </div>
    )
  }

  return (
    <div className={s.page}>
      {header}
      <div className={s.body}>
        <div className={s.intro}>
          <h2 className={s.h1} aria-live="polite">
            {left === 0 ? 'All gaps handled' : `${countWord(left)} ${left === 1 ? 'gap' : 'gaps'} to look at`}
          </h2>
          <p className={s.lede}>The job asks for these and your CV does not fully show them. We only add what you tell us is true.</p>
        </div>
        <ul className={s.list}>
          {open.map((g) => (
            <li key={g.id}>
              <GapCard appId={id} gap={g} roles={roles} />
            </li>
          ))}
        </ul>
      </div>
      <div className={s.footer}>
        <ButtonLink to={back} variant={left === 0 ? 'primary' : 'secondary'} block>
          {left === 0 ? 'Done' : 'Decide later'}
        </ButtonLink>
      </div>
    </div>
  )
}

type Mode = 'auto' | 'choose' | 'write'

function GapCard({ appId, gap, roles }: { appId: string; gap: Gap; roles: string[] }) {
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
          <h2 id={`${fieldId}-name`} className={s.name}>{gap.requirement}</h2>
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
