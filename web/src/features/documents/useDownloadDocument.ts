import { useState } from 'react'
import { isApiError } from '../../api/client'
import { startRender, useFreshFiles, waitForJob, type DocumentItem } from './api'
import { triggerDownload } from './download'

/** Key for the row being downloaded: CVs by application, letters by letter id. */
export const docKey = (d: DocumentItem) => (d.kind === 'cv' ? `cv:${d.application_id}` : `letter:${d.id}`)

/**
 * Download one document's PDF from the Documents list. Renders it first if
 * the file is missing or out of date.
 */
export function useDownloadDocument() {
  const fresh = useFreshFiles()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const download = async (d: DocumentItem) => {
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
      triggerDownload(url)
    } catch (e) {
      setError(isApiError(e) || e instanceof Error ? e.message : 'That did not work. Try again.')
    } finally {
      setBusy(null)
    }
  }

  return { download, busy, error }
}
