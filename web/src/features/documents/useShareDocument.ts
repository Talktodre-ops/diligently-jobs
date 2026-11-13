import { useState } from 'react'
import { isApiError } from '../../api/client'
import { startRender, useFreshFiles, waitForJob, type DocumentItem } from './api'
import { MIME, shareOrDownload, triggerDownload } from './download'
import { fileNameFromUrl } from './format'

/** Key for the row being shared: CVs by application, letters by letter id. */
export const docKey = (d: DocumentItem) => (d.kind === 'cv' ? `cv:${d.application_id}` : `letter:${d.id}`)

/**
 * Share (or, without a share sheet, download) one document's PDF from the
 * Documents list. Renders it first if the file is missing or out of date.
 */
export function useShareDocument() {
  const fresh = useFreshFiles()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const share = async (d: DocumentItem) => {
    setBusy(docKey(d))
    setError(null)
    try {
      let links = await fresh(d.application_id)
      const missing = d.kind === 'cv' ? !links.cv.pdf_url || !links.cv.up_to_date : !links.letter.pdf_url
      if (missing) {
        const started = await startRender(d.application_id, d.kind === 'letter')
        const ids = [started.cv_job_id, started.letter_job_id].filter((j): j is string => !!j)
        const jobs = await Promise.all(ids.map((j) => waitForJob(j)))
        if (jobs.some((j) => j.status === 'failed')) throw new Error('The file did not render. Try again.')
        links = await fresh(d.application_id)
      }
      const url = d.kind === 'cv' ? links.cv.pdf_url : links.letter.pdf_url
      if (!url) throw new Error('The file is not ready yet. Try again in a moment.')
      const name = fileNameFromUrl(url) ?? (d.kind === 'cv' ? 'CV.pdf' : 'Cover letter.pdf')
      if (missing) {
        // The render took a while, so the tap no longer counts as a gesture
        // for the share sheet; a download always works.
        triggerDownload(url)
      } else {
        await shareOrDownload([{ url, name, type: MIME.pdf }], null, name)
      }
    } catch (e) {
      setError(isApiError(e) || e instanceof Error ? e.message : 'That did not work. Try again.')
    } finally {
      setBusy(null)
    }
  }

  return { share, busy, error }
}
