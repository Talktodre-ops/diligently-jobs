import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { Button } from '../../ui/Button'
import { Notice } from '../../ui/Notice'
import { PageState } from '../../ui/PageState'
import { DESKTOP, useMediaQuery } from '../../ui/useMediaQuery'
import { useFreshFiles } from '../documents/api'
import { PdfPages, type PageChange } from '../documents/PdfPages'
import { Segmented } from '../documents/Segmented'
import { useRenderedFiles } from '../documents/useRenderedFiles'
import { useGaps, useRewrites, useTailoredCv } from './api'
import { CvPaper } from './CvPaper'
import { reviewItems } from './reviewItems'
import s from './CvTab.module.css'

type View = 'page' | 'read'

/**
 * The CV tab. Page, the default, is the PDF exactly as LaTeX set it, the file
 * that gets downloaded, with each change highlighted and opening its suggestion. It
 * is set in type again after every decision, and says so when typesetting
 * fails, so nothing is downloaded unseen. Read is the same CV as text, for screen
 * readers and small screens.
 */
export function CvTab({ id, onOpen }: { id: string; onOpen: (itemId: string) => void }) {
  // In the address (?view=read) like the tab, so it survives a reload and a
  // window crossing the desktop width.
  const [params, setParams] = useSearchParams()
  const view: View = params.get('view') === 'read' ? 'read' : 'page'
  const setView = (v: View) =>
    setParams((p) => { const n = new URLSearchParams(p); if (v === 'read') n.set('view', 'read'); else n.delete('view'); return n }, { replace: true })
  const desktop = useMediaQuery(DESKTOP)
  const cv = useTailoredCv(id)
  const rewrites = useRewrites(id)
  const gaps = useGaps(id)
  const { files, preparing, renderError, retry } = useRenderedFiles(id, { letter: false })
  const fresh = useFreshFiles()
  const [attempt, setAttempt] = useState(0)

  const changes = useMemo<PageChange[]>(() => {
    const out: PageChange[] = rewrites.data
      ? reviewItems(rewrites.data)
        .filter((i) => i.status !== 'kept')
        .map((i) => ({ id: i.id, text: i.chosen, seen: i.status !== 'pending', label: i.where }))
      : []
    for (const g of gaps.data?.gaps ?? []) {
      if (g.bullet_status === 'accepted' && g.suggested_bullet) out.push({ id: null, text: g.suggested_bullet, seen: true, label: g.requirement })
    }
    return out
  }, [rewrites.data, gaps.data])
  const changesKey = changes.map((c) => `${c.id}:${c.seen}:${c.text}`).join('|')

  const toggle = (
    <Segmented<View> label="How to show your CV" value={view} onChange={setView} options={[{ value: 'page', label: 'Page' }, { value: 'read', label: 'Read' }]} />
  )

  if (view === 'read') {
    return (
      <div className={s.tab}>
        <div className={s.bar}>{toggle}</div>
        {cv.data && cv.data.issues.length > 0 && (
          <Notice>Worth checking before you download: {cv.data.issues.map((i) => i.message).join(' ')}</Notice>
        )}
        <CvPaper id={id} changeSearch={(itemId) => `?view=read&change=${encodeURIComponent(itemId)}`} />
      </div>
    )
  }

  const pdfUrl = files.data?.cv.pdf_url
  const redraw = async () => {
    await fresh(id).catch(() => undefined)
    setAttempt((n) => n + 1)
  }

  let page
  if (files.isError) {
    page = <PageState.Error error={files.error} onRetry={() => files.refetch()} />
  } else if (renderError) {
    page = (
      <div className={s.failed} role="alert">
        <p className={s.failedTitle}>Your CV did not set in type.</p>
        <p className={s.failedText}>
          Download waits until it works. Try again; if it keeps failing, the Read view shows the text meanwhile.
        </p>
        <Button variant="secondary" small onClick={retry}>Try again</Button>
      </div>
    )
  } else if (!pdfUrl || rewrites.isPending || gaps.isPending) {
    page = <Preparing text="Setting your CV in type. This takes a few seconds." />
  } else {
    page = (
      <>
        {preparing && <Preparing text="Setting your change in type." />}
        <div className={preparing ? s.stale : undefined}>
          <PdfPages key={`${files.data?.cv.rendered_at}-${attempt}-${changesKey}`} url={pdfUrl} changes={changes} onOpen={onOpen} onRetry={redraw} />
        </div>
        <p className={s.caption}>
          Exactly what the recruiter gets. Highlights show what changed for this job and open it; the file has none.
          {!desktop && ' Pinch to zoom.'}
        </p>
      </>
    )
  }

  return (
    <div className={s.tab}>
      <div className={s.bar}>
        {toggle}
        <p className={s.legend}>
          <span className={s.used}>Changed for this job</span> <span className={s.waiting}>Not looked at yet</span>
        </p>
      </div>
      {page}
    </div>
  )
}

function Preparing({ text }: { text: string }) {
  return (
    <div className={s.preparing} role="status" aria-live="polite">
      <span className={s.dot} aria-hidden="true" />
      {text}
    </div>
  )
}
