import { Button } from '../../ui/Button'
import { Icon } from '../../ui/Icon'
import type { FileLinks } from './api'
import { fileNameFromUrl } from './format'
import s from './CvPreview.module.css'

export type Format = 'pdf' | 'docx'

type Props = {
  files: FileLinks | undefined
  busy: Format | null
  disabled: boolean
  onDownload: (f: Format) => void
}

/** "Download PDF" and "Download DOCX", each naming the file the person will get. */
export function DownloadChoices({ files, busy, disabled, onDownload }: Props) {
  const rows: { f: Format; label: string; url: string | null | undefined }[] = [
    { f: 'pdf', label: 'Download PDF', url: files?.cv.pdf_url },
    { f: 'docx', label: 'Download DOCX', url: files?.cv.docx_url },
  ]
  return (
    <div className={s.choices}>
      {rows.map((r) => (
        <div key={r.f} className={s.choice}>
          <Button variant="quiet" block busy={busy === r.f} disabled={disabled || !r.url} onClick={() => onDownload(r.f)}>
            {busy !== r.f && <Icon name="download" size={18} />}
            {r.label}
          </Button>
          {r.url && <span className={s.fileName}>{fileNameFromUrl(r.url)}</span>}
        </div>
      ))}
    </div>
  )
}
