import { useId, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import s from './TextField.module.css'

type Base = { label: string; hint?: string; error?: string | null; hideLabel?: boolean }

export function TextField({ label, hint, error, hideLabel, id, className, ...rest }: Base & InputHTMLAttributes<HTMLInputElement>) {
  const auto = useId()
  const inputId = id ?? auto
  const describedBy = [hint && `${inputId}-hint`, error && `${inputId}-err`].filter(Boolean).join(' ') || undefined
  return (
    <div className={[s.field, className].filter(Boolean).join(' ')}>
      <label htmlFor={inputId} className={hideLabel ? 'visually-hidden' : s.label}>{label}</label>
      <input
        id={inputId}
        className={[s.control, error && s.invalid].filter(Boolean).join(' ')}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...rest}
      />
      {hint && !error && <span id={`${inputId}-hint`} className={s.hint}>{hint}</span>}
      {error && <span id={`${inputId}-err`} className={s.error} role="alert">{error}</span>}
    </div>
  )
}

export function TextArea({ label, hint, error, hideLabel, id, className, ...rest }: Base & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const auto = useId()
  const inputId = id ?? auto
  const describedBy = [hint && `${inputId}-hint`, error && `${inputId}-err`].filter(Boolean).join(' ') || undefined
  return (
    <div className={[s.field, className].filter(Boolean).join(' ')}>
      <label htmlFor={inputId} className={hideLabel ? 'visually-hidden' : s.label}>{label}</label>
      <textarea
        id={inputId}
        className={[s.control, error && s.invalid].filter(Boolean).join(' ')}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...rest}
      />
      {hint && !error && <span id={`${inputId}-hint`} className={s.hint}>{hint}</span>}
      {error && <span id={`${inputId}-err`} className={s.error} role="alert">{error}</span>}
    </div>
  )
}
