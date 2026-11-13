import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { Button } from '../../ui/Button'
import { Icon } from '../../ui/Icon'
import { Notice } from '../../ui/Notice'
import { PageState } from '../../ui/PageState'
import { TopBar } from '../../ui/TopBar'
import { Dialog } from '../../ui/Dialog'
import { companyName, useBrief } from '../apply/api'
import { Switch } from '../../ui/Switch'
import { DESKTOP, useMediaQuery } from '../../ui/useMediaQuery'
import { useFreshFiles, useLetter, useMarkApplied, type Applied, type FileLinks } from './api'
import { canShareFiles, fetchAsFiles, MIME, shareOrDownload, type ShareFile, type ShareOutcome } from './download'
import { fileNameFromUrl, shownScore } from './format'
import { SendDone } from './SendDone'
import { useRenderedFiles } from './useRenderedFiles'
import s from './Send.module.css'

type Format = 'pdf' | 'docx'
const FORMATS: { value: Format; label: string; note: string }[] = [
  { value: 'pdf', label: 'PDF', note: 'Recommended. Keeps the layout exactly.' },
  { value: 'docx', label: 'DOCX', note: 'For portals that ask for Word.' },
]
const DEFAULT_REMINDER_DAYS = 7

function pick(links: FileLinks | undefined, format: Format, letter: boolean): ShareFile[] {
  if (!links) return []
  const out: ShareFile[] = []
  const add = (url: string | null, fallback: string) => {
    if (url) out.push({ url, name: fileNameFromUrl(url) ?? `${fallback}.${format}`, type: MIME[format] })
  }
  add(format === 'pdf' ? links.cv.pdf_url : links.cv.docx_url, 'CV')
  if (letter) add(format === 'pdf' ? links.letter.pdf_url : links.letter.docx_url, 'Cover letter')
  return out
}

export default function SendPage() {
  const { id = '' } = useParams()
  const brief = useBrief(id)
  const letter = useLetter(id)
  const fresh = useFreshFiles()
  const markApplied = useMarkApplied(id)
  const [format, setFormat] = useState<Format>('pdf')
  const [withLetter, setWithLetter] = useState(true)
  const [phase, setPhase] = useState<'choose' | 'confirm' | 'done'>('choose')
  const [outcome, setOutcome] = useState<ShareOutcome>('downloaded')
  const [sharing, setSharing] = useState(false)
  const [shareError, setShareError] = useState<string | null>(null)
  const [applied, setApplied] = useState<Applied | null>(null)
  const [shareable] = useState(canShareFiles)
  const desktop = useMediaQuery(DESKTOP)
  const [prepared, setPrepared] = useState<{ key: string; files: File[] } | null>(null)

  const hasLetter = !!letter.data?.doc
  const includeLetter = hasLetter && withLetter
  const { files, preparing, renderError, retry } = useRenderedFiles(id, { letter: includeLetter, enabled: !letter.isPending })
  const selected = pick(files.data, format, includeLetter)
  const expected = includeLetter ? 2 : 1
  const ready = !preparing && !renderError && selected.length === expected
  const selectionKey = `${format}:${includeLetter}:${files.data?.cv.rendered_at}:${selected.map((f) => f.name).join('|')}`

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

  const company = companyName(brief.data?.application.company)
  const top = <TopBar back={`/applications/${id}/cv`} backLabel="Back to preview" eyebrow={company} title="Send" />

  if (brief.isPending || letter.isPending) return (<>{top}<PageState.Loading /></>)
  if (brief.isError) return (<>{top}<PageState.Error error={brief.error} onRetry={() => brief.refetch()} /></>)

  if (phase === 'done') {
    return (
      <SendDone
        company={company}
        role={brief.data.application.role}
        score={shownScore(brief.data.score)}
        reminder={applied?.reminder ?? null}
        initialDays={DEFAULT_REMINDER_DAYS}
      />
    )
  }

  const title = `${company} application`
  const share = async () => {
    setSharing(true)
    setShareError(null)
    try {
      const ahead = prepared?.key === selectionKey ? prepared.files : null
      const list = ahead ? selected : pick(await fresh(id), format, includeLetter)
      const result = await shareOrDownload(list, ahead, title)
      if (result !== 'cancelled') {
        setOutcome(result)
        setPhase('confirm')
      }
    } catch (e) {
      setShareError(e instanceof Error ? e.message : 'That did not work. Try again.')
    } finally {
      setSharing(false)
    }
  }

  const confirm = () =>
    markApplied.mutate(DEFAULT_REMINDER_DAYS, {
      onSuccess: (r) => { setApplied(r); setPhase('done') },
    })

  const fileRows = (
    <div className={s.files}>
      <div className={s.filesTitle} id="files-title">Files</div>
      {preparing && (
        <p className={s.preparing} role="status" aria-live="polite">Setting your files in type. This takes a few seconds.</p>
      )}
      {renderError && (
        <div className={s.renderError}>
          <Notice tone="error">{renderError.message}</Notice>
          <Button variant="secondary" small onClick={retry}>Try again</Button>
        </div>
      )}
      {!preparing && !renderError && (
        <ul className={s.fileList} aria-labelledby="files-title">
          {selected.map((f) => (
            <li key={f.name} className={s.fileRow}>
              <span className={s.ext}>{format.toUpperCase()}</span>
              <span className={s.fileName}>{f.name}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )

  const shareLabel = shareable ? 'Share' : expected > 1 ? 'Download files' : 'Download file'
  const action = (
    <Button block onClick={share} busy={sharing} disabled={!ready}>
      {!sharing && <Icon name={shareable ? 'share' : 'download'} size={18} />}
      {shareLabel}
    </Button>
  )

  return (
    <>
      {top}
      <div className={s.layout}>
        <main className={s.main}>
          <h1 className={s.h1}>How should it go out?</h1>

          <fieldset className={s.fieldset}>
            <legend className={s.legend}>Format</legend>
            {FORMATS.map((f) => (
              <label key={f.value} className={s.option}>
                <input type="radio" name="format" value={f.value} checked={format === f.value} onChange={() => setFormat(f.value)} className={s.radio} />
                <span className={s.optionText}>
                  <span className={s.optionLabel}>{f.label}</span>
                  <span className={s.optionNote}>{f.note}</span>
                </span>
              </label>
            ))}
          </fieldset>

          {hasLetter ? (
            <div className={s.letterRow}>
              <span className={s.optionText}>
                <span className={s.optionLabel}>Include cover letter</span>
                <span className={s.optionNote}>As a second file</span>
              </span>
              <Switch checked={withLetter} onChange={setWithLetter} label="Include cover letter" />
            </div>
          ) : (
            <p className={s.noLetter}>
              No cover letter for this job yet. <Link to={`/applications/${id}/letter`}>Write one</Link> if you want to send it too.
            </p>
          )}

          {!desktop && fileRows}
        </main>

        <aside className={s.side} aria-label="Send">
          {desktop && fileRows}
          {shareError && <Notice tone="error">{shareError}</Notice>}
          {action}
          {!shareable && <p className={s.sideNote}>Attach the {expected > 1 ? 'files' : 'file'} wherever you apply: the job portal or an email to the recruiter.</p>}
        </aside>
      </div>

      {phase === 'confirm' && (
        <Dialog title="Did you send it?" onClose={() => setPhase('choose')}>
          <p className={s.dialogText}>
            {outcome === 'shared'
              ? 'We cannot see what happens after the share sheet. Tell us and we will track it.'
              : 'We cannot see where the files go after they download. Tell us once it is sent and we will track it.'}
          </p>
          {markApplied.isError && <Notice tone="error">{markApplied.error.message}</Notice>}
          <Button block busy={markApplied.isPending} onClick={confirm}>Yes, mark as applied</Button>
          <Button block variant="secondary" onClick={() => setPhase('choose')} disabled={markApplied.isPending}>Not yet</Button>
        </Dialog>
      )}
    </>
  )
}
