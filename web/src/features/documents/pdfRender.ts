// PDF.js, loaded only when the CV is shown as a page (see PdfPages). It
// draws the rendered PDF onto a canvas, so the phone shows the exact page the
// recruiter gets, and finds where changed text sits so it can be highlighted.
import { getDocument, GlobalWorkerOptions, Util, type PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = workerUrl

/** A highlight box as fractions of the page, so it scales with the canvas, and what it belongs to. */
export type Mark<T> = { left: number; top: number; width: number; height: number; of: T }

const MAX_CANVAS_SIDE = 4096

export function loadPdf(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  return getDocument({ data }).promise
}

/**
 * Renders page `n` (1-based) into `canvas`, sharp enough to pinch-zoom on a
 * phone, and returns the page's aspect ratio and the boxes of text runs that
 * `match` places, each with what it matched.
 */
export async function renderPage<T>(
  pdf: PDFDocumentProxy,
  n: number,
  canvas: HTMLCanvasElement,
  cssWidth: number,
  match: (text: string) => T | null,
): Promise<{ aspect: number; marks: Mark<T>[] }> {
  const page = await pdf.getPage(n)
  const base = page.getViewport({ scale: 1 })
  const density = Math.min(3, (window.devicePixelRatio || 1) * 2)
  const scale = Math.min((cssWidth / base.width) * density, MAX_CANVAS_SIDE / Math.max(base.width, base.height))
  const viewport = page.getViewport({ scale })
  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  await page.render({ canvas, viewport }).promise

  const marks: Mark<T>[] = []
  const text = await page.getTextContent()
  for (const item of text.items) {
    if (!('str' in item)) continue
    const of = match(item.str)
    if (of === null) continue
    const tx = Util.transform(base.transform, item.transform) as number[]
    const fontHeight = Math.hypot(tx[2]!, tx[3]!)
    const left = tx[4]!
    const top = tx[5]! - fontHeight * 0.88
    marks.push({
      left: left / base.width,
      top: top / base.height,
      width: item.width / base.width,
      height: (fontHeight * 1.12) / base.height,
      of,
    })
  }
  page.cleanup()
  return { aspect: base.height / base.width, marks }
}
