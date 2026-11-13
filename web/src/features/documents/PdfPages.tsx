import { useEffect, useRef, useState } from 'react'
import { Button } from '../../ui/Button'
import { PageState } from '../../ui/PageState'
import { containsAtWordBoundary } from './highlights'
import s from './PdfPages.module.css'

type Props = {
  /** Presigned PDF link. Read once on mount; remount (key) to show a new render. */
  url: string
  /** Normalised text the user changed for this job, highlighted on the page. */
  changed: string[]
  /** Called from the error state; the parent fetches a fresh link and remounts. */
  onRetry: () => void
}

const norm = (t: string) => t.replace(/\s+/g, ' ').trim()

/**
 * The rendered PDF, page by page, drawn with PDF.js. A phone browser cannot
 * show a PDF inline reliably (Android Chrome downloads it, iOS shows one
 * page without zoom control in an iframe), so the page is drawn to a canvas
 * instead. Highlights are an overlay; the file itself has none.
 */
export function PdfPages({ url, changed, onRetry }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const [src] = useState(url)
  const [wanted] = useState(() => changed.map(norm).filter((c) => c.length > 0))
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')

  useEffect(() => {
    const host = box.current
    if (!host) return
    let cancelled = false
    const isChanged = (text: string) => {
      const t = norm(text)
      return t.length >= 10 && wanted.some((c) => containsAtWordBoundary(c, t))
    }
    ;(async () => {
      try {
        const [{ loadPdf, renderPage }, res] = await Promise.all([import('./pdfRender'), fetch(src)])
        if (!res.ok) throw new Error(`pdf ${res.status}`)
        const pdf = await loadPdf(await res.arrayBuffer())
        if (cancelled) return void pdf.loadingTask.destroy()
        host.replaceChildren()
        const width = host.clientWidth || 360
        for (let n = 1; n <= pdf.numPages; n++) {
          const page = document.createElement('div')
          page.className = s.page!
          page.setAttribute('role', 'img')
          page.setAttribute('aria-label', `CV page ${n} of ${pdf.numPages}, as rendered`)
          const canvas = document.createElement('canvas')
          canvas.className = s.canvas!
          page.appendChild(canvas)
          host.appendChild(page)
          const { aspect, marks } = await renderPage(pdf, n, canvas, width, isChanged)
          if (cancelled) return void pdf.loadingTask.destroy()
          page.style.aspectRatio = `1 / ${aspect}`
          for (const m of marks) {
            const hl = document.createElement('span')
            hl.className = s.mark!
            hl.style.left = `${m.left * 100}%`
            hl.style.top = `${m.top * 100}%`
            hl.style.width = `${m.width * 100}%`
            hl.style.height = `${m.height * 100}%`
            page.appendChild(hl)
          }
        }
        await pdf.loadingTask.destroy()
        if (!cancelled) setStatus('ready')
      } catch {
        if (!cancelled) setStatus('error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [src, wanted])

  return (
    <div className={s.wrap}>
      {status === 'loading' && <PageState.Loading label="Drawing your page" />}
      {status === 'error' && (
        <div className={s.error} role="alert">
          <p>The page did not load. Your files are fine; try drawing it again, or switch to Read.</p>
          <Button variant="secondary" small onClick={onRetry}>Try again</Button>
        </div>
      )}
      <div ref={box} className={s.pages} data-testid="pdf-pages" data-status={status} hidden={status === 'error'} />
    </div>
  )
}
