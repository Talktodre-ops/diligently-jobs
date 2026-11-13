import { Link } from 'react-router'
import { Button } from '../../ui/Button'
import { Icon } from '../../ui/Icon'
import type { DocumentItem } from './api'
import { ago, capitalise } from './format'
import s from './Documents.module.css'

export function documentTitle(d: DocumentItem) {
  return `${d.kind === 'cv' ? 'CV' : 'Letter'} · ${d.company?.trim() || 'Untitled job'}`
}

/** A stored score of 0 is a failed scoring run, not a real match, so it is not shown. */
function meta(d: DocumentItem) {
  if (d.kind === 'cv') {
    return [d.role, d.score != null && d.score > 0 ? `match ${d.score}` : null, d.formats.map((f) => f.toUpperCase()).join(', ')].filter(Boolean).join(' · ')
  }
  return `${capitalise(d.tone)} tone · ${d.words} words`
}

export function DocumentRow({ doc, busy, disabled, onShare }: { doc: DocumentItem; busy: boolean; disabled: boolean; onShare: () => void }) {
  const title = documentTitle(doc)
  const to = `/applications/${doc.application_id}/${doc.kind === 'cv' ? 'cv' : 'letter'}`
  return (
    <li className={s.row}>
      <span className={doc.kind === 'cv' ? s.iconCv : s.iconLetter} aria-hidden="true">
        <Icon name="document" size={20} />
      </span>
      <Link to={to} className={s.rowLink}>
        <span className={s.rowTitle}>{title}</span>
        <span className={s.rowMeta}>{meta(doc)}</span>
        <span className={s.rowWhen}>{capitalise(ago(doc.updated_at))}</span>
      </Link>
      <Button variant="ghost" small iconOnly aria-label={`Share ${title}`} busy={busy} disabled={disabled} onClick={onShare}>
        {!busy && <Icon name="share" size={20} />}
      </Button>
    </li>
  )
}
