// PDF.js, loaded only when someone opens the Page view (see PdfPages). It
// draws the rendered PDF onto a canvas, so the phone shows the exact page the
// recruiter gets, and finds where changed text sits so it can be highlighted.
import { getDocument, GlobalWorkerOptions, Util, type PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = workerUrl

/** A highlight box as fractions of the page, so it scales with the canvas. */
export type Mark = { left: number; top: number; width: number; height: number }

const MAX_CANVAS_SIDE = 4096

export function loadPdf(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  return getDocument({ data }).promise
}

/**
 * Renders page `n` (1-based) into `canvas`, sharp enough to pinch-zoom on a
 * phone, and returns the page's aspect ratio and the boxes of text runs that
 * `isChanged` accepts.
 */
export async function renderPage(
  pdf: PDFDocumentProxy,
  n: number,
  canvas: HTMLCanvasElement,
  cssWidth: number,
  isChanged: (text: string) => boolean,
): Promise<{ aspect: number; marks: Mark[] }> {
  const page = await pdf.getPage(n)
  const base = page.getViewport({ scale: 1 })
  const density = Math.min(3, (window.devicePixelRatio || 1) * 2)
  const scale = Math.min((cssWidth / base.width) * density, MAX_CANVAS_SIDE / Math.max(base.width, base.height))
  const viewport = page.getViewport({ scale })
  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  await page.render({ canvas, viewport }).promise

  const marks: Mark[] = []
  const text = await page.getTextContent()
  for (const item of text.items) {
    if (!('str' in item) || !isChanged(item.str)) continue
    const tx = Util.transform(base.transform, item.transform) as number[]
    const fontHeight = Math.hypot(tx[2]!, tx[3]!)
    const left = tx[4]!
    const top = tx[5]! - fontHeight * 0.88
    marks.push({
      left: left / base.width,
      top: top / base.height,
      width: item.width / base.width,
      height: (fontHeight * 1.12) / base.height,
    })
  }
  page.cleanup()
  return { aspect: base.height / base.width, marks }
}
