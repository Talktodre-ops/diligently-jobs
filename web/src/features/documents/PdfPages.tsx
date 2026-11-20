import { useEffect, useRef, useState } from 'react'
import { Button } from '../../ui/Button'
import { PageState } from '../../ui/PageState'
import s from './PdfPages.module.css'

/** A line that changed for this job. `id` opens it; a gap bullet has none. */
export type PageChange = { id: string | null; text: string; seen: boolean; label: string }

type Props = {
  /** Presigned PDF link. Read once on mount; remount (key) to show a new render. */
  url: string
  /** What changed for this job, highlighted where it sits on the page. */
  changes: PageChange[]
  /** Opens a change from its highlight. */
  onOpen: (id: string) => void
  /** Called from the error state; the parent fetches a fresh link and remounts. */
  onRetry: () => void
}

const norm = (t: string) => t.replace(/\s+/g, ' ').trim()

/** The name a highlight reads out: where, the start of the line, and whether it was looked at. */
export function changeName(c: PageChange) {
  const start = c.text.length > 60 ? `${c.text.slice(0, 57).trimEnd()}...` : c.text
  return `Open the change in ${c.label}: ${start}${c.seen ? '' : ' (not looked at yet)'}`
}

/** A PDF line is part of a changed passage only if it sits on word edges
 *  ("Experience" the heading is not part of "Experienced with"). */
export function containsAtWordBoundary(haystack: string, needle: string): boolean {
  const word = /[\p{L}\p{N}]/u
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) {
    const before = haystack[i - 1]
    const after = haystack[i + needle.length]
    if ((!before || !word.test(before)) && (!after || !word.test(after))) return true
  }
  return false
}

/**
 * The CV exactly as LaTeX set it, page by page, drawn with PDF.js. A phone
 * browser cannot show a PDF inline reliably (Android Chrome downloads it, iOS
 * shows one page without zoom control in an iframe), so the page is drawn to
 * a canvas instead. Highlights are an overlay; the file itself has none. Each
 * highlighted change is one tab stop that opens it.
 */
export function PdfPages({ url, changes, onOpen, onRetry }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const [src] = useState(url)
  const [wanted] = useState(() => changes.map((c) => ({ ...c, text: norm(c.text) })).filter((c) => c.text.length > 0))
  // The highlights are drawn once per page; they call whatever onOpen is now.
  const open = useRef(onOpen)
  useEffect(() => { open.current = onOpen }, [onOpen])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')

  useEffect(() => {
    const host = box.current
    if (!host) return
    let cancelled = false
    const match = (text: string) => {
      const t = norm(text)
      if (t.length < 10) return null
      return wanted.find((c) => containsAtWordBoundary(c.text, t)) ?? null
    }
    ;(async () => {
      try {
        const [{ loadPdf, renderPage }, res] = await Promise.all([import('./pdfRender'), fetch(src)])
        if (!res.ok) throw new Error(`pdf ${res.status}`)
        const pdf = await loadPdf(await res.arrayBuffer())
        if (cancelled) return void pdf.loadingTask.destroy()
        host.replaceChildren()
        const width = host.clientWidth || 360
        const reachable = new Set<string>()
        for (let n = 1; n <= pdf.numPages; n++) {
          const page = document.createElement('div')
          page.className = s.page!
          const canvas = document.createElement('canvas')
          canvas.className = s.canvas!
          canvas.setAttribute('role', 'img')
          canvas.setAttribute('aria-label', `CV page ${n} of ${pdf.numPages}, as rendered`)
          page.appendChild(canvas)
          host.appendChild(page)
          const { aspect, marks } = await renderPage(pdf, n, canvas, width, match)
          if (cancelled) return void pdf.loadingTask.destroy()
          page.style.aspectRatio = `1 / ${aspect}`
          for (const m of marks) {
            const id = m.of.id
            const hl = document.createElement(id ? 'button' : 'span')
            hl.className = [s.mark, m.of.seen ? '' : s.markNew].filter(Boolean).join(' ')
            hl.style.left = `${m.left * 100}%`
            hl.style.top = `${m.top * 100}%`
            hl.style.width = `${m.width * 100}%`
            hl.style.height = `${m.height * 100}%`
            if (id && hl instanceof HTMLButtonElement) {
              hl.type = 'button'
              hl.addEventListener('click', () => open.current(id))
              // One tab stop and one name per change, however many lines it spans.
              if (reachable.has(id)) {
                hl.tabIndex = -1
                hl.setAttribute('aria-hidden', 'true')
              } else {
                reachable.add(id)
                hl.setAttribute('aria-label', changeName(m.of))
              }
            } else {
              hl.setAttribute('aria-hidden', 'true')
            }
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
