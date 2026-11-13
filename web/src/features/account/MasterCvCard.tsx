import { useRef, useState } from 'react'
import { isApiError } from '../../api/client'
import { Button } from '../../ui/Button'
import { Notice } from '../../ui/Notice'
import { useMasterCv, useStartUpload, useUploadStatus } from './api'
import s from './ProfilePage.module.css'

const MAX = 5 * 1024 * 1024

export function MasterCvCard() {
  const cv = useMasterCv()
  const start = useStartUpload()
  const input = useRef<HTMLInputElement>(null)
  const [uploadId, setUploadId] = useState<string | null>(null)
  const [tooBig, setTooBig] = useState(false)
  const status = useUploadStatus(uploadId)
  const upload = status.data
  const working = start.isPending || (!!uploadId && (!upload || upload.status === 'queued' || upload.status === 'reading'))

  const pick = (file: File | undefined) => {
    if (!file) return
    setTooBig(false)
    if (file.size > MAX) { setTooBig(true); return }
    setUploadId(null)
    start.mutate(file, { onSuccess: ({ upload: u }) => setUploadId(u.id) })
  }

  const updated = cv.data ? new Date(cv.data.updated_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null

  return (
    <section className={s.card} aria-label="Master CV">
      <div className={s.cvText}>
        <h2 className={s.cardTitle}>Master CV</h2>
        <p className={s.muted}>Every tailored CV starts here. Edits here never change CVs you already sent.</p>
        {cv.data && <p className={s.small}>Last replaced {updated}{cv.data.issues.length > 0 ? `, ${cv.data.issues.length} thing${cv.data.issues.length === 1 ? '' : 's'} to check` : ''}.</p>}
        {cv.data === null && <p className={s.small}>You have not uploaded a CV yet.</p>}
      </div>
      <div className={s.cvActions}>
        <input ref={input} type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" className="visually-hidden" aria-label="Choose a CV file" tabIndex={-1} onChange={(e) => { pick(e.target.files?.[0]); e.target.value = '' }} />
        <Button variant="quiet" small busy={working} onClick={() => input.current?.click()}>{cv.data ? 'Upload new' : 'Upload CV'}</Button>
      </div>
      <div className={s.cvStatus} role="status" aria-live="polite">
        {working && <span>Reading your CV. This takes a few seconds.</span>}
        {upload?.status === 'done' && <span>Your master CV is replaced with {upload.filename}.</span>}
      </div>
      {tooBig && <Notice tone="error">That file is over 5 MB. Choose a smaller PDF or DOCX.</Notice>}
      {start.isError && <Notice tone="error">{isApiError(start.error) ? start.error.message : 'The upload failed. Try again.'}</Notice>}
      {upload?.status === 'failed' && <Notice tone="error">{upload.error || 'We could not read that file. Try a different PDF or DOCX.'}</Notice>}
    </section>
  )
}
