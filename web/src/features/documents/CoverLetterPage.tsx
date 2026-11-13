import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { companyName, useBrief } from '../apply/api'
import { DESKTOP, useMediaQuery } from '../../ui/useMediaQuery'
import { Button } from '../../ui/Button'
import { Icon } from '../../ui/Icon'
import { Notice } from '../../ui/Notice'
import { PageState } from '../../ui/PageState'
import { TopBar } from '../../ui/TopBar'
import { TONES, letterParagraphs, useEditLetter, useLetter, useRegenerateLetter, type Letter, type Tone } from './api'
import { capitalise, countWords } from './format'
import { LetterParagraph } from './LetterParagraph'
import s from './CoverLetter.module.css'

function plainText(letter: Letter, paragraphs: string[]) {
  const d = letter.doc
  const sign = [d?.signoff, d?.candidate_name].filter(Boolean).join('\n')
  return [d?.greeting, ...paragraphs, sign].filter(Boolean).join('\n\n')
}

export default function CoverLetterPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const brief = useBrief(id)
  const letter = useLetter(id)
  const regenerate = useRegenerateLetter(id)
  const edit = useEditLetter(id)
  const desktop = useMediaQuery(DESKTOP)
  const [editing, setEditing] = useState<number | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => () => clearTimeout(toastTimer.current), [])

  const company = companyName(brief.data?.application.company)
  const back = `/applications/${id}`
  const l = letter.data
  const paragraphs = l ? letterParagraphs(l) : []
  const words = countWords(paragraphs)
  const top = <TopBar back={back} backLabel="Back to application" eyebrow={company} title="Cover letter" end={l ? <span className={s.words}>{words} words</span> : undefined} />

  if (brief.isPending || letter.isPending) return (<>{top}<PageState.Loading label="Loading your letter" /></>)
  if (brief.isError) return (<>{top}<PageState.Error error={brief.error} onRetry={() => brief.refetch()} /></>)
  if (letter.isError) return (<>{top}<PageState.Error error={letter.error} onRetry={() => letter.refetch()} /></>)

  const busy = regenerate.isPending || edit.isPending
  const writingTone = regenerate.isPending ? regenerate.variables : null

  if (!l) {
    return (
      <>
        {top}
        <div className={s.emptyWrap}>
          <PageState.Empty
            title="No letter yet"
            body={`We can draft one for ${company} from the CV decisions you made, in a tone you choose.`}
            action={<Button busy={regenerate.isPending} onClick={() => regenerate.mutate('direct')}>Write a letter</Button>}
          />
          {regenerate.isError && <Notice tone="error">{regenerate.error.message}</Notice>}
        </div>
      </>
    )
  }

  const showToast = (text: string) => {
    setToast(text)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 1800)
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(plainText(l, paragraphs))
      showToast('Copied to clipboard')
    } catch {
      showToast('Copy did not work here. Select the text and copy it yourself.')
    }
  }

  const pickTone = (tone: Tone) => {
    if (busy || tone === l.tone) return
    setEditing(null)
    edit.reset()
    regenerate.mutate(tone)
  }

  const save = (index: number, text: string) => {
    const next = paragraphs.map((p, i) => (i === index ? text : p))
    edit.mutate({ letterId: l.id, paragraphs: next }, { onSuccess: () => setEditing(null) })
  }

  const tones = (
    <div className={s.tones} role="group" aria-label="Tone">
      <span className={s.toneLabel} aria-hidden="true">Tone</span>
      {TONES.map((t) => (
        <button
          key={t}
          type="button"
          className={s.tone}
          aria-pressed={l.tone === t}
          aria-busy={writingTone === t || undefined}
          disabled={busy && writingTone !== t}
          onClick={() => pickTone(t)}
        >
          {writingTone === t && <span className={s.spinner} aria-hidden="true" />}
          {capitalise(t)}
        </button>
      ))}
    </div>
  )

  const actions = (
    <>
      <Button variant="secondary" onClick={copy} disabled={busy}>
        <Icon name="copy" size={18} />
        Copy
      </Button>
      <Button className={s.use} onClick={() => navigate(back)} disabled={busy}>Use this letter</Button>
    </>
  )

  const status = (
    <div role="status" aria-live="polite" className={s.status}>
      {writingTone ? `Writing a ${writingTone} version. This takes a few seconds.` : ''}
    </div>
  )

  const article = (
    <article className={[s.letter, regenerate.isPending && s.dimmed].filter(Boolean).join(' ')} aria-label="Your cover letter" aria-busy={regenerate.isPending || undefined}>
      {l.doc?.greeting && <p className={s.fixed}>{l.doc.greeting}</p>}
      {paragraphs.map((p, i) => (
        <LetterParagraph
          key={`${l.id}-${i}`}
          index={i}
          text={p}
          editing={editing === i}
          disabled={busy || (editing !== null && editing !== i)}
          saving={edit.isPending}
          error={editing === i && edit.isError ? edit.error.message : null}
          onEdit={() => { edit.reset(); setEditing(i) }}
          onCancel={() => setEditing(null)}
          onSave={(text) => save(i, text)}
        />
      ))}
      {(l.doc?.signoff || l.doc?.candidate_name) && (
        <p className={s.fixed}>
          {l.doc?.signoff}
          {l.doc?.signoff && <br />}
          {l.doc?.candidate_name}
        </p>
      )}
    </article>
  )

  const hint = <p className={s.hint}>Tap a paragraph to edit it. Picking another tone writes a new letter from your CV decisions.</p>

  return (
    <>
      {top}
      {desktop ? (
        <div className={s.desk}>
          <div className={s.paperCol}>{article}</div>
          <aside className={s.side} aria-label="Letter options">
            {tones}
            {status}
            {regenerate.isError && <Notice tone="error">{regenerate.error.message}</Notice>}
            {hint}
            <div className={s.sideActions}>{actions}</div>
          </aside>
        </div>
      ) : (
        <>
          <div className={s.toneBar}>{tones}</div>
          <div className={s.body}>
            {status}
            {regenerate.isError && <Notice tone="error">{regenerate.error.message}</Notice>}
            {article}
            {hint}
          </div>
          <footer className={s.footer}>{actions}</footer>
        </>
      )}
      <div role="status" aria-live="polite" className={toast ? s.toast : 'visually-hidden'}>{toast}</div>
    </>
  )
}
