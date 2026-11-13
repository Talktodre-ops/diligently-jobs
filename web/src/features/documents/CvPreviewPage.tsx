import { useMemo, useState } from 'react'
import { useParams } from 'react-router'
import { isApiError } from '../../api/client'
import { Button, ButtonLink } from '../../ui/Button'
import { Icon } from '../../ui/Icon'
import { Notice } from '../../ui/Notice'
import { PageState } from '../../ui/PageState'
import { ScoreBar } from '../../ui/ScoreBar'
import { TopBar } from '../../ui/TopBar'
import { Dialog } from '../../ui/Dialog'
import { companyName, useBrief, useGaps, useRewrites, useTailoredCv } from '../apply/api'
import { DESKTOP, useMediaQuery } from '../../ui/useMediaQuery'
import { useFreshFiles } from './api'
import { DownloadChoices, type Format } from './DownloadChoices'
import { triggerDownload } from './download'
import { shownScore } from './format'
import { changedTexts, countChanged } from './highlights'
import { PdfPages } from './PdfPages'
import { ResumeRead } from './ResumeRead'
import { Segmented } from './Segmented'
import { useRenderedFiles } from './useRenderedFiles'
import s from './CvPreview.module.css'

type View = 'page' | 'read'

export default function CvPreviewPage() {
  const { id = '' } = useParams()
  const brief = useBrief(id)
  const cv = useTailoredCv(id)
  const rewrites = useRewrites(id)
  const gaps = useGaps(id)
  const { files, preparing, renderError, retry } = useRenderedFiles(id, { letter: false })
  const fresh = useFreshFiles()
  const desktop = useMediaQuery(DESKTOP)
  const [view, setView] = useState<View>('page')
  const [pdfAttempt, setPdfAttempt] = useState(0)
  const [choosing, setChoosing] = useState(false)
  const [downloading, setDownloading] = useState<Format | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const changed = useMemo(() => changedTexts(rewrites.data, gaps.data?.gaps), [rewrites.data, gaps.data])
  const changedKey = useMemo(() => [...changed].sort().join('|'), [changed])

  const company = companyName(brief.data?.application.company)
  const toggle = (
    <Segmented<View> label="Document view" value={view} onChange={setView} options={[{ value: 'read', label: 'Read' }, { value: 'page', label: 'Page' }]} />
  )
  const top = <TopBar back={`/applications/${id}`} backLabel="Back to application" eyebrow={`Tailored for ${company}`} title="Your CV" end={toggle} />

  if (brief.isPending || cv.isPending) return (<>{top}<PageState.Loading label="Loading your CV" /></>)
  if (brief.isError) return (<>{top}<PageState.Error error={brief.error} onRetry={() => brief.refetch()} /></>)
  if (cv.isError) return (<>{top}<PageState.Error error={cv.error} onRetry={() => cv.refetch()} /></>)

  const score = shownScore(brief.data.score)
  const before = brief.data.score.before
  const nChanged = countChanged(cv.data.doc, changed)
  const changeNote = nChanged === 0 ? 'No changes yet' : `${nChanged} ${nChanged === 1 ? 'change' : 'changes'} highlighted`
  const ready = !preparing && !renderError && !!files.data?.cv.pdf_url

  const download = async (f: Format) => {
    setDownloading(f)
    setDownloadError(null)
    try {
      const links = await fresh(id)
      const url = f === 'pdf' ? links.cv.pdf_url : links.cv.docx_url
      if (!url) throw new Error('That file is not ready yet. Try again in a moment.')
      triggerDownload(url)
      setChoosing(false)
    } catch (e) {
      setDownloadError(isApiError(e) || e instanceof Error ? e.message : 'The download did not start. Try again.')
    } finally {
      setDownloading(null)
    }
  }

  const redrawPage = async () => {
    await fresh(id).catch(() => undefined)
    setPdfAttempt((n) => n + 1)
  }

  let page
  if (files.isError) {
    page = <PageState.Error error={files.error} onRetry={() => files.refetch()} />
  } else if (renderError) {
    page = (
      <div className={s.renderError}>
        <Notice tone="error">{renderError.message}</Notice>
        <Button variant="secondary" small onClick={retry}>Try again</Button>
      </div>
    )
  } else if (preparing || !files.data?.cv.pdf_url || rewrites.isPending || gaps.isPending) {
    page = (
      <div className={s.preparing} role="status" aria-live="polite">
        <span className={s.dot} aria-hidden="true" />
        Setting your CV in type. This takes a few seconds.
      </div>
    )
  } else {
    page = (
      <>
        <PdfPages key={`${files.data.cv.rendered_at}-${pdfAttempt}-${changedKey}`} url={files.data.cv.pdf_url} changed={[...changed]} onRetry={redrawPage} />
        <p className={s.caption}>
          <span className={s.swatch} aria-hidden="true" />
          Exactly what the recruiter gets. Highlights show what changed for this job; the file has none.
          {!desktop && ' Pinch to zoom.'}
        </p>
      </>
    )
  }

  const read = (
    <>
      {cv.data.issues.length > 0 && (
        <Notice>
          Worth checking before you send: {cv.data.issues.map((i) => i.message).join(' ')}
        </Notice>
      )}
      <ResumeRead doc={cv.data.doc} changed={changed} />
    </>
  )

  const scoreBar = score != null ? <ScoreBar score={score} before={before != null && before < score ? before : null} meta={changeNote} /> : <p className={s.changeNote}>{changeNote}</p>
  const sendLink = (
    <ButtonLink to={`/applications/${id}/send`} className={s.send} block={desktop}>
      <Icon name="send" size={18} />
      Send CV
    </ButtonLink>
  )

  return (
    <>
      {top}
      <div className={desktop ? s.desk : s.phone}>
        <div className={s.stage}>{view === 'page' ? page : read}</div>
        {desktop ? (
          <aside className={s.panel} aria-label="Download and send">
            <h2 className={s.panelTitle}>Ready when you are</h2>
            {scoreBar}
            <DownloadChoices files={files.data} busy={downloading} disabled={!ready} onDownload={download} />
            {downloadError && <Notice tone="error">{downloadError}</Notice>}
            {sendLink}
          </aside>
        ) : (
          <section className={s.sheet} aria-label="Download and send">
            {scoreBar}
            <div className={s.sheetActions}>
              <Button variant="secondary" iconOnly aria-label="Download PDF or DOCX" onClick={() => { setDownloadError(null); setChoosing(true) }}>
                <Icon name="download" size={20} />
              </Button>
              {sendLink}
            </div>
          </section>
        )}
      </div>
      {choosing && (
        <Dialog title="Download your CV" onClose={() => setChoosing(false)}>
          {!ready && <p className={s.dialogNote}>Your files are still being set in type.</p>}
          <DownloadChoices files={files.data} busy={downloading} disabled={!ready} onDownload={download} />
          {downloadError && <Notice tone="error">{downloadError}</Notice>}
          <Button variant="ghost" onClick={() => setChoosing(false)}>Cancel</Button>
        </Dialog>
      )}
    </>
  )
}
