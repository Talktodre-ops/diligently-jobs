import { useEffect, useId, useRef, type ReactNode } from 'react'
import s from './Dialog.module.css'

type Props = { title: string; role?: 'dialog' | 'alertdialog'; onClose: () => void; children: ReactNode }

/**
 * A modal sheet. Focus moves in on open, Escape closes, Tab stays inside, and
 * focus returns to what opened it.
 */
export function Dialog({ title, role = 'dialog', onClose, children }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    const box = ref.current!
    const focusable = () => Array.from(box.querySelectorAll<HTMLElement>('button, input, a[href], select, textarea, [tabindex]:not([tabindex="-1"])')).filter((el) => !el.hasAttribute('disabled'))
    const first = box.querySelector<HTMLElement>('input, select, textarea') ?? focusable()[0]
    first?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return }
      if (e.key !== 'Tab') return
      const f = focusable()
      if (f.length === 0) return
      const i = f.indexOf(document.activeElement as HTMLElement)
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1]!.focus() }
      else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0]!.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey); before?.focus?.() }
    // onClose is intentionally read once; the dialog is remounted per use.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className={s.scrim} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={ref} className={s.sheet} role={role} aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId} className={s.title}>{title}</h2>
        {children}
      </div>
    </div>
  )
}
