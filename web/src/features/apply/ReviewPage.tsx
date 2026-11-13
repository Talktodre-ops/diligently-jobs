import { useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { isApiError } from '../../api/client'
import { Button, ButtonLink } from '../../ui/Button'
import { Icon } from '../../ui/Icon'
import { PageState } from '../../ui/PageState'
import { TextArea } from '../../ui/TextField'
import { TopBar } from '../../ui/TopBar'
import { companyName, useBrief, useRewrites, type Score } from './api'
import { plural } from './format'
import { decisionWord, reviewItems, type ReviewItem } from './reviewItems'
import { useDecide } from './useDecide'
import { DESKTOP, useMediaQuery } from '../../ui/useMediaQuery'
import surface from './onSurface.module.css'
import s from './ReviewPage.module.css'

/**
 * Review rewrites one at a time. By default it walks the ones still
 * waiting; "Go through them again" (or picking one from the list on
 * desktop) walks them in order so a decision can be changed.
 */
export default function ReviewPage() {
  const { id = '' } = useParams()
  const [params] = useSearchParams()
  const itemParam = params.get('item')
  const brief = useBrief(id)
  const rewrites = useRewrites(id)
  const decide = useDecide(id)
  const desktop = useMediaQuery(DESKTOP)
  const [cursor, setCursor] = useState<number | 'param' | null>(itemParam ? 'param' : null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [draftError, setDraftError] = useState<string | null>(null)
  const [lastAction, setLastAction] = useState<'accept' | 'keep' | 'edit'>('accept')

  if (rewrites.isPending) return <PageState.Loading />
  if (rewrites.isError) return <PageState.Error error={rewrites.error} onRetry={() => rewrites.refetch()} />

  const items = reviewItems(rewrites.data)
  const score = rewrites.data.score
  const company = companyName(brief.data?.application.company)
  const back = `/applications/${id}`

  const paramIndex = cursor === 'param' ? items.findIndex((i) => i.id === itemParam) : -1
  const explicit = typeof cursor === 'number' ? cursor : paramIndex >= 0 ? paramIndex : null
  const index = explicit ?? items.findIndex((i) => i.status === 'pending')
  const current = index >= 0 ? items[index] : undefined
  const waiting = items.filter((i) => i.status === 'pending').length
  const editing = !!current && editingId === current.id

  function after() {
    setEditingId(null)
    setDraftError(null)
    if (explicit !== null) setCursor(explicit + 1 < items.length ? explicit + 1 : null)
  }

  function act(action: 'accept' | 'keep') {
    if (!current) return
    setLastAction(action)
    decide.decide(current, { action }, after)
  }

  function startEdit(item: ReviewItem) {
    setEditingId(item.id)
    setDraft(item.rewrite)
    setDraftError(null)
  }

  function saveEdit() {
    if (!current) return
    const text = draft.trim()
    if (!text) return setDraftError('Write the line you want, or cancel to keep the choices as they are.')
    setLastAction('edit')
    decide.decide(current, { action: 'edit', text }, after)
  }

  const header = (
    <TopBar
      back={back}
      backLabel="Back to application"
      eyebrow={company}
      title="Review rewrites"
      end={<MatchChip score={score} />}
    />
  )

  if (items.length === 0) {
    return (
      <div className={s.page}>
        {header}
        <PageState.Empty title="Nothing to review" body="We did not suggest any changes for this job." action={<Link to={back}>Back to application</Link>} />
      </div>
    )
  }

  const decideError = current && decide.errorFor === current.id && decide.error
    ? isApiError(decide.error) ? decide.error.message : 'That did not save. Try again.'
    : null

  return (
    <div className={s.page}>
      {header}
      <div className={s.layout}>
        <div className={s.mainCol}>
          {current ? (
            <>
              <div className={s.titleRow}>
                <h2 className={s.h1}>{current.status === 'pending' ? `${waiting} left to review` : 'Change your choice'}</h2>
                <span className={s.position}>{index + 1} of {items.length}</span>
              </div>
              <ItemCard
                item={current}
                editing={editing}
                draft={draft}
                draftError={draftError ?? (editing ? decideError : null)}
                busy={decide.busy}
                onDraft={setDraft}
                onEdit={() => startEdit(current)}
                onCancel={() => setEditingId(null)}
                onSave={saveEdit}
              />
              {decideError && !editing && <p className={s.error} role="alert">{decideError}</p>}
              {!editing && (
                <div className={s.footer}>
                  <Button variant="secondary" busy={decide.busy && lastAction === 'keep'} disabled={decide.busy} onClick={() => act('keep')}>
                    Keep original
                  </Button>
                  <Button busy={decide.busy && lastAction === 'accept'} disabled={decide.busy} onClick={() => act('accept')}>
                    Use rewrite
                  </Button>
                </div>
              )}
            </>
          ) : (
            <Done items={items} score={score} back={back} id={id} onAgain={() => setCursor(0)} />
          )}
        </div>

        {desktop && <nav aria-label="All rewrites" className={s.sideCol}>
          <h2 className={s.sideH2}>All rewrites</h2>
          <ol className={s.sideList}>
            {items.map((item, i) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={s.sideItem}
                  aria-current={current?.id === item.id ? 'step' : undefined}
                  onClick={() => { setEditingId(null); setCursor(i) }}
                >
                  <span className={s.sideWhere}>{item.where}</span>
                  <span className={s.sideText}>{item.rewrite}</span>
                  <span className={item.status === 'pending' ? s.sideWaiting : s.sideStatus}>{decisionWord(item.status)}</span>
                </button>
              </li>
            ))}
          </ol>
        </nav>}
      </div>
    </div>
  )
}

function MatchChip({ score }: { score: Score }) {
  if (score.current == null) return null
  return (
    <span className={s.chip} role="status" aria-live="polite">
      Match {score.current}
    </span>
  )
}

type CardProps = {
  item: ReviewItem
  editing: boolean
  draft: string
  draftError: string | null
  busy: boolean
  onDraft: (v: string) => void
  onEdit: () => void
  onCancel: () => void
  onSave: () => void
}

function ItemCard({ item, editing, draft, draftError, busy, onDraft, onEdit, onCancel, onSave }: CardProps) {
  const label = item.status === 'edited' ? 'Your edit' : 'Rewrite'
  return (
    <section aria-label={item.where} className={s.card}>
      <div className={s.where}>{item.where}</div>
      <div className={s.block}>
        <div className={s.label}>Original</div>
        <p className={s.original}>{item.original || 'Your CV has no summary yet.'}</p>
      </div>
      <div className={s.rule} />
      <div className={s.block}>
        <div className={s.labelRow}>
          <div className={s.labelAccent}>{label}</div>
          {!editing && (
            <button type="button" className={s.editButton} onClick={onEdit}>
              <Icon name="edit" size={14} strokeWidth={2} />
              Edit
            </button>
          )}
        </div>
        {editing ? (
          <div className={s.editArea}>
            <TextArea label="Edit the rewrite" hideLabel value={draft} onChange={(e) => onDraft(e.target.value)} rows={4} error={draftError} autoFocus />
            <div className={s.editButtons}>
              <Button variant="ghost" small onClick={onCancel} disabled={busy}>Cancel</Button>
              <Button variant="dark" className={surface.solid} small onClick={onSave} busy={busy}>Save and use</Button>
            </div>
          </div>
        ) : (
          <p className={s.rewrite}>{item.rewrite}</p>
        )}
      </div>
      {item.status !== 'pending' && <p className={s.current}>Now: {decisionWord(item.status).toLowerCase()}</p>}
      {(item.why || item.needsNumber) && (
        <div className={item.needsNumber ? s.whyNumber : s.why}>
          <Icon name={item.needsNumber ? 'edit' : 'alert'} size={16} strokeWidth={1.8} className={s.whyIcon} />
          <span>
            {item.needsNumber && <strong>A number would make this stronger. </strong>}
            {item.why}
          </span>
        </div>
      )}
    </section>
  )
}

function Done({ items, score, back, id, onAgain }: { items: ReviewItem[]; score: Score; back: string; id: string; onAgain: () => void }) {
  const used = items.filter((i) => i.status === 'accepted' || i.status === 'edited').length
  return (
    <div className={s.done}>
      <div className={s.doneMark} aria-hidden="true"><Icon name="check" size={34} strokeWidth={2} /></div>
      <h2 className={s.doneH1}>All reviewed</h2>
      <p className={s.doneBody}>
        You used {used} of {plural(items.length, 'rewrite')}.{score.current != null ? ` Your match is ${score.current}.` : ''} Your master CV is unchanged.
      </p>
      <button type="button" className={s.again} onClick={onAgain}>Go through them again</button>
      <div className={s.doneActions}>
        <ButtonLink to={`/applications/${id}/cv`} block>Preview CV</ButtonLink>
        <ButtonLink to={back} variant="secondary" block>Back to application</ButtonLink>
      </div>
    </div>
  )
}
