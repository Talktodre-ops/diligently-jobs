import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { Button } from '../../ui/Button'
import { PageState } from '../../ui/PageState'
import { DESKTOP, useMediaQuery } from '../../ui/useMediaQuery'
import { letterParagraphs, useFreshFiles, useLetter, type Letter } from '../documents/api'
import { LetterPanel } from '../documents/LetterPanel'
import { PdfPages } from '../documents/PdfPages'
import { Segmented } from '../documents/Segmented'
import { useRenderedFiles } from '../documents/useRenderedFiles'
import s from './CvTab.module.css'

type View = 'page' | 'edit'

/** Changes whenever the letter's words or tone do, so the page redraws then and only then. */
function contentKey(l: Letter) {
  const text = `${l.tone}\n${letterParagraphs(l).join('\n')}`
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return `${l.id}:${h >>> 0}`
}

/**
 * The Letter tab. Page, the default, is the letter exactly as LaTeX set it,
 * the file that gets downloaded, so it is never attached unseen. Edit is the
 * text: the tone and one paragraph at a time. Every edit sets the page in
 * type again.
 */
export function LetterTab({ id, company }: { id: string; company: string }) {
  const [params, setParams] = useSearchParams()
  const view: View = params.get('view') === 'edit' ? 'edit' : 'page'
  const setView = (v: View) =>
    setParams((p) => { const n = new URLSearchParams(p); if (v === 'edit') n.set('view', 'edit'); else n.delete('view'); return n }, { replace: true })
  const desktop = useMediaQuery(DESKTOP)
  const letter = useLetter(id)
  const hasLetter = !!letter.data?.doc
  const { files, preparing, renderError, retry } = useRenderedFiles(id, { letter: true, enabled: hasLetter && view === 'page' })
  const fresh = useFreshFiles()
  const [attempt, setAttempt] = useState(0)

  if (letter.isPending) return <PageState.Loading label="Loading your letter" />
  // No letter yet, or it did not load: the text panel offers writing one or a retry.
  if (!hasLetter) return <LetterPanel id={id} company={company} />

  const toggle = (
    <Segmented<View> label="How to show your letter" value={view} onChange={setView} options={[{ value: 'page', label: 'Page' }, { value: 'edit', label: 'Edit' }]} />
  )
  if (view === 'edit') {
    return (
      <div className={s.tab}>
        <div className={s.bar}>{toggle}</div>
        <LetterPanel id={id} company={company} />
      </div>
    )
  }

  // Links fetched before the latest edit point at the old file; wait for newer ones.
  const current = files.dataUpdatedAt >= letter.dataUpdatedAt
  const pdfUrl = current ? files.data?.letter.pdf_url : null
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
        <p className={s.failedTitle}>Your letter did not set in type.</p>
        <p className={s.failedText}>Download waits until it works. Try again; the Edit view shows the text meanwhile.</p>
        <Button variant="secondary" small onClick={retry}>Try again</Button>
      </div>
    )
  } else if (!pdfUrl || preparing) {
    page = (
      <div className={s.preparing} role="status" aria-live="polite">
        <span className={s.dot} aria-hidden="true" />
        Setting your letter in type. This takes a few seconds.
      </div>
    )
  } else {
    page = (
      <>
        <PdfPages key={`${contentKey(letter.data!)}-${attempt}`} url={pdfUrl} what="Cover letter" changes={[]} onOpen={() => {}} onRetry={redraw} />
        <p className={s.caption}>
          Exactly what the recruiter gets. To change the tone or a paragraph, switch to Edit.
          {!desktop && ' Pinch to zoom.'}
        </p>
      </>
    )
  }

  return (
    <div className={s.tab}>
      <div className={s.bar}>{toggle}</div>
      {page}
    </div>
  )
}
