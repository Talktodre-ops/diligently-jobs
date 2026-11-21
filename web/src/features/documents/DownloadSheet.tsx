import { useEffect, useRef, useState } from 'react'
import { Button } from '../../ui/Button'
import { Icon } from '../../ui/Icon'
import { Notice } from '../../ui/Notice'
import { useProfile } from '../../auth/session'
import { Dialog } from '../../ui/Dialog'
import { companyName, useBrief } from '../apply/api'
import { useFreshFiles, useLetter, useMarkApplied, type Applied, type FileLinks } from './api'
import { canShareFiles, fetchAsFiles, MIME, shareOrDownload, triggerDownload, type ShareFile } from './download'
import { fileNameFromUrl, shownScore } from './format'
import { plural } from '../apply/format'
import { track } from '../../api/track'
import { AppliedDone } from './AppliedDone'
import { useRenderedFiles } from './useRenderedFiles'
import s from './Download.module.css'

type Format = 'pdf' | 'docx'
type Kind = 'cv' | 'letter'
const FORMATS: { value: Format; label: string; note: string }[] = [
  { value: 'pdf', label: 'PDF', note: 'Recommended. Keeps the layout exactly.' },
  { value: 'docx', label: 'DOCX', note: 'For portals that ask for Word.' },
]
const WHAT: Record<Kind, string> = { cv: 'CV', letter: 'Cover letter' }
/** Used when the profile has not loaded; the API's own default. */
const DEFAULT_REMINDER_DAYS = 7

type Picked = ShareFile & { kind: Kind }

function pick(links: FileLinks | undefined, format: Format, kinds: Kind[]): Picked[] {
  if (!links) return []
  return kinds.flatMap((kind) => {
    const url = format === 'pdf' ? links[kind].pdf_url : links[kind].docx_url
    return url ? [{ kind, url, name: fileNameFromUrl(url) ?? `${WHAT[kind]}.${format}`, type: MIME[format] }] : []
  })
}

type Props = {
  id: string
  onClose: () => void
  /** Open the suggestions not looked at yet. */
  onReview: () => void
  /** Go to the Letter tab to write one. */
  onWriteLetter: () => void
}

/**
 * Download, as a sheet over the application: the CV and the cover letter,
 * both set in type by LaTeX, each on its own or together, as PDF or DOCX.
 * Nothing is sent anywhere; the person attaches the files wherever they
 * apply. Afterwards it asks whether they applied, to track the job and set
 * the follow-up.
 */
export function DownloadSheet({ id, onClose, onReview, onWriteLetter }: Props) {
  const brief = useBrief(id)
  const letter = useLetter(id)
  const fresh = useFreshFiles()
  const markApplied = useMarkApplied(id)
  const reminderDays = useProfile().data?.reminders.follow_up_days ?? DEFAULT_REMINDER_DAYS
  const [format, setFormat] = useState<Format>('pdf')
  const [done, setDone] = useState(false)
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState<Kind | 'all' | 'share' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [applied, setApplied] = useState<Applied | null>(null)
  const [shareable] = useState(canShareFiles)
  const [prepared, setPrepared] = useState<{ key: string; files: File[] } | null>(null)
  const askRef = useRef<HTMLElement>(null)

  const hasLetter = !!letter.data?.doc
  const kinds: Kind[] = hasLetter ? ['cv', 'letter'] : ['cv']
  const { files, preparing, renderError, retry } = useRenderedFiles(id, { letter: hasLetter, enabled: !letter.isPending })
  const selected = pick(files.data, format, kinds)
  const ready = !preparing && !renderError && selected.length === kinds.length
  const selectionKey = `${format}:${kinds.join('+')}:${files.data?.cv.rendered_at}:${selected.map((f) => f.name).join('|')}`

  // On phones the share sheet must open straight from the tap, so the files
  // are fetched ahead of it.
  useEffect(() => {
    if (!shareable || !ready) return
    let cancelled = false
    fetchAsFiles(selected)
      .then((list) => { if (!cancelled) setPrepared({ key: selectionKey, files: list }) })
      .catch(() => { /* the tap falls back to fetching, then downloading */ })
    return () => { cancelled = true }
    // selected is derived from selectionKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareable, ready, selectionKey])

  // On a phone the question lands below the fold; bring it up after the tap.
  useEffect(() => {
    if (asking) askRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
  }, [asking])

  const company = companyName(brief.data?.application.company)
  const named = !!brief.data?.application.company?.trim()

  if (done && brief.data) {
    return (
      <AppliedDone
        company={company}
        role={brief.data.application.role}
        score={shownScore(brief.data.score)}
        reminder={applied?.reminder ?? null}
        initialDays={reminderDays}
        onClose={onClose}
      />
    )
  }

  /** Links are signed for ten minutes, so each tap fetches a fresh set. */
  const download = async (which: Kind | 'all') => {
    setBusy(which)
    setError(null)
    try {
      const list = pick(await fresh(id), format, which === 'all' ? kinds : [which])
      if (list.length === 0) throw new Error('That file is not ready yet. Try again in a moment.')
      list.forEach((f, i) => setTimeout(() => triggerDownload(f.url), i * 400))
      track('files_downloaded', id, { format, files: list.map((f) => f.kind).join('+'), via: 'downloaded' })
      setAsking(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work. Try again.')
    } finally {
      setBusy(null)
    }
  }

  const share = async () => {
    setBusy('share')
    setError(null)
    try {
      const ahead = prepared?.key === selectionKey ? prepared.files : null
      const list = ahead ? selected : pick(await fresh(id), format, kinds)
      const result = await shareOrDownload(list, ahead, named ? `${company} application` : 'Job application')
      if (result !== 'cancelled') {
        track('files_downloaded', id, { format, files: list.map((f) => f.kind).join('+'), via: result })
        setAsking(true)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work. Try again.')
    } finally {
      setBusy(null)
    }
  }

  const confirm = () =>
    markApplied.mutate(reminderDays, {
      onSuccess: (r) => { setApplied(r); setDone(true) },
    })

  const loading = brief.isPending || letter.isPending
  const both = kinds.length > 1

  return (
    <Dialog title="Download your files" onClose={onClose}>
      {named && <p className={s.forWhom}>For {[company, brief.data?.application.role].filter(Boolean).join(', ')}</p>}
      {brief.isError && <Notice tone="error">{brief.error.message}</Notice>}
      {brief.data && <ChangesNote inCv={brief.data.score.decided} notSeen={brief.data.score.pending} onReview={onReview} />}

      <fieldset className={s.fieldset}>
        <legend className={s.legend}>Format</legend>
        <div className={s.options}>
          {FORMATS.map((f) => (
            <label key={f.value} className={s.option}>
              <input type="radio" name="format" value={f.value} checked={format === f.value} onChange={() => setFormat(f.value)} className={s.radio} />
              <span className={s.optionText}>
                <span className={s.optionLabel}>{f.label}</span>
                <span className={s.optionNote}>{f.note}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className={s.files}>
        <div className={s.filesTitle} id="files-title">Files</div>
        {(preparing || loading) && (
          <p className={s.preparing} role="status" aria-live="polite">Setting your files in type. This takes a few seconds.</p>
        )}
        {renderError && (
          <div className={s.renderError}>
            <Notice tone="error">{renderError.message}</Notice>
            <Button variant="secondary" small onClick={retry}>Try again</Button>
          </div>
        )}
        {!preparing && !loading && !renderError && (
          <ul className={s.fileList} aria-labelledby="files-title">
            {selected.map((f) => (
              <li key={f.kind} className={s.fileRow}>
                <span className={s.ext}>{format.toUpperCase()}</span>
                <span className={s.fileText}>
                  <span className={s.fileWhat}>{WHAT[f.kind]}</span>
                  <span className={s.fileName}>{f.name}</span>
                </span>
                <Button
                  variant="secondary"
                  small
                  busy={busy === f.kind}
                  disabled={busy !== null && busy !== f.kind}
                  onClick={() => download(f.kind)}
                  aria-label={`Download the ${f.kind === 'cv' ? 'CV' : 'cover letter'} as ${format.toUpperCase()}`}
                >
                  {busy !== f.kind && <Icon name="download" size={16} />}
                  Download
                </Button>
              </li>
            ))}
          </ul>
        )}
        {!loading && !hasLetter && (
          <p className={s.noLetter}>
            No cover letter for this job yet. <button type="button" className={s.inlineLink} onClick={onWriteLetter}>Write one</button> and it shows up here too.
          </p>
        )}
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      <Button block onClick={() => download('all')} busy={busy === 'all'} disabled={!ready || (busy !== null && busy !== 'all')}>
        {busy !== 'all' && <Icon name="download" size={18} />}
        {both ? 'Download both' : 'Download CV'}
      </Button>
      {shareable && (
        <Button block variant="secondary" onClick={share} busy={busy === 'share'} disabled={!ready || (busy !== null && busy !== 'share')}>
          {busy !== 'share' && <Icon name="share" size={18} />}
          Share to an app
        </Button>
      )}

      {asking ? (
        <section ref={askRef} className={s.ask} aria-labelledby="ask-title">
          <h3 id="ask-title" className={s.askTitle}>Did you apply?</h3>
          <p className={s.dialogText}>
            We cannot see where the files go. Once you have applied, tell us and we will track the job and remind you to follow up.
          </p>
          {markApplied.isError && <Notice tone="error">{markApplied.error.message}</Notice>}
          <div className={s.askActions}>
            <Button busy={markApplied.isPending} onClick={confirm}>Yes, I applied</Button>
            <Button variant="secondary" onClick={() => setAsking(false)} disabled={markApplied.isPending}>Not yet</Button>
          </div>
        </section>
      ) : (
        <p className={s.sideNote}>
          Attach {both ? 'them' : 'it'} wherever you apply: the job portal or an email to the recruiter.
        </p>
      )}
    </Dialog>
  )
}

/** How far the CV moved from the original, and what was not looked at. */
function ChangesNote({ inCv, notSeen, onReview }: { inCv: number; notSeen: number; onReview: () => void }) {
  if (inCv === 0) return <p className={s.changes}>Your CV is as you wrote it.</p>
  return (
    <p className={s.changes}>
      Your CV has {plural(inCv, 'change')} for this job.
      {notSeen > 0 && (
        <>
          {' '}You have not looked at {notSeen}. <button type="button" className={s.inlineLink} onClick={onReview}>Look them over</button>
        </>
      )}
    </p>
  )
}
