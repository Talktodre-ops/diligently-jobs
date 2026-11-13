import { useId, useState } from 'react'
import { Button } from '../../ui/Button'
import s from './CoverLetter.module.css'

type Props = {
  index: number
  text: string
  editing: boolean
  disabled: boolean
  saving: boolean
  error: string | null
  onEdit: () => void
  onCancel: () => void
  onSave: (text: string) => void
}

/** One body paragraph. Tap to edit in place; nothing is saved until Save. */
export function LetterParagraph({ index, text, editing, disabled, saving, error, onEdit, onCancel, onSave }: Props) {
  const [draft, setDraft] = useState(text)
  const id = useId()

  if (!editing) {
    return (
      <button type="button" className={s.para} onClick={() => { setDraft(text); onEdit() }} disabled={disabled} aria-describedby={`${id}-hint`}>
        {text}
        <span id={`${id}-hint`} className="visually-hidden">Edit paragraph {index + 1}</span>
      </button>
    )
  }

  const trimmed = draft.trim()
  return (
    <form
      className={s.editor}
      onSubmit={(e) => { e.preventDefault(); if (trimmed) onSave(trimmed) }}
    >
      <label htmlFor={id} className={s.editLabel}>Paragraph {index + 1}</label>
      <textarea
        id={id}
        className={s.editArea}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={Math.min(14, Math.max(4, Math.ceil(draft.length / 42)))}
        autoFocus
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-err` : undefined}
        onKeyDown={(e) => { if (e.key === 'Escape') onCancel() }}
      />
      {error && <span id={`${id}-err`} role="alert" className={s.editError}>{error}</span>}
      <div className={s.editActions}>
        <Button type="submit" small busy={saving} disabled={!trimmed || trimmed === text.trim()}>Save paragraph</Button>
        <Button variant="ghost" small onClick={onCancel} disabled={saving}>Cancel</Button>
      </div>
    </form>
  )
}
