import { useId, useState, type KeyboardEvent } from 'react'
import { Link } from 'react-router'
import { ButtonLink } from '../../ui/Button'
import { Icon } from '../../ui/Icon'
import { Notice } from '../../ui/Notice'
import { PageState } from '../../ui/PageState'
import { useMasterCv } from '../account/api'
import { useDocuments, type DocumentKind } from './api'
import { DocumentRow } from './DocumentRow'
import { ago } from './format'
import { docKey, useShareDocument } from './useShareDocument'
import s from './Documents.module.css'

const FILTERS: { value: DocumentKind; label: string; empty: string }[] = [
  { value: 'all', label: 'All', empty: 'No documents yet' },
  { value: 'cv', label: 'CVs', empty: 'No tailored CVs yet' },
  { value: 'letter', label: 'Letters', empty: 'No letters yet' },
]

function MasterCard() {
  const master = useMasterCv()
  if (master.isPending) return <div className={s.master} aria-busy="true"><span className="visually-hidden">Loading your master CV</span></div>
  const cv = master.data
  return (
    <Link to="/profile" className={s.master}>
      <span className={s.thumb} aria-hidden="true">
        <span className={s.thumbHead} />
        <span /><span /><span className={s.thumbShort} /><span />
      </span>
      <span className={s.masterText}>
        <span className={s.masterLabel}>Master CV</span>
        <span className={s.masterName}>{cv?.doc.header.name || (master.isError ? 'Your master CV' : 'No master CV yet')}</span>
        <span className={s.masterNote}>
          {cv ? `Updated ${ago(cv.updated_at)} · the source for every tailored CV` : 'Open your profile to add one'}
        </span>
      </span>
      <Icon name="forward" size={20} />
    </Link>
  )
}

export default function DocumentsPage() {
  const [kind, setKind] = useState<DocumentKind>('all')
  const docs = useDocuments(kind)
  const sharing = useShareDocument()
  const base = useId()
  const current = FILTERS.find((f) => f.value === kind)!

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const next = FILTERS[(i + (e.key === 'ArrowRight' ? 1 : FILTERS.length - 1)) % FILTERS.length]!
    setKind(next.value)
    document.getElementById(`${base}-${next.value}`)?.focus()
  }

  let list
  if (docs.isPending) list = <PageState.Loading label="Loading documents" />
  else if (docs.isError) list = <PageState.Error error={docs.error} onRetry={() => docs.refetch()} />
  else if (docs.data.documents.length === 0) {
    list = (
      <PageState.Empty
        title={current.empty}
        body="Tailor your CV to a job and the files you send show up here, ready to share again."
        action={<ButtonLink to="/new" small>Add a job</ButtonLink>}
      />
    )
  } else {
    list = (
      <ul className={s.list}>
        {docs.data.documents.map((d) => (
          <DocumentRow
            key={docKey(d)}
            doc={d}
            busy={sharing.busy === docKey(d)}
            disabled={sharing.busy !== null && sharing.busy !== docKey(d)}
            onShare={() => sharing.share(d)}
          />
        ))}
      </ul>
    )
  }

  return (
    <div className={s.page}>
      <header className={s.header}>
        <h1 className={s.h1}>Documents</h1>
      </header>
      <div className={s.grid}>
        <div className={s.aside}>
          <MasterCard />
        </div>
        <div className={s.listCol}>
          <div role="tablist" aria-label="Filter documents" className={s.filters}>
            {FILTERS.map((f, i) => (
              <button
                key={f.value}
                id={`${base}-${f.value}`}
                type="button"
                role="tab"
                aria-selected={kind === f.value}
                aria-controls={`${base}-panel`}
                tabIndex={kind === f.value ? 0 : -1}
                className={s.filter}
                onClick={() => setKind(f.value)}
                onKeyDown={(e) => onKey(e, i)}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div id={`${base}-panel`} role="tabpanel" aria-labelledby={`${base}-${kind}`} className={s.panel}>
            <div role="status" aria-live="polite" className="visually-hidden">
              {sharing.busy ? 'Preparing the file.' : ''}
            </div>
            {sharing.error && <Notice tone="error">{sharing.error}</Notice>}
            {list}
          </div>
        </div>
      </div>
    </div>
  )
}
