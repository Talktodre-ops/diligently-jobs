import { useId, useState, type InputHTMLAttributes } from 'react'
import s from './PasswordField.module.css'

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange'> & {
  label: string
  value: string
  onChange: (v: string) => void
  error?: string | null
  /** Show a length meter toward this many characters. */
  minLength?: number
  labelEnd?: React.ReactNode
}

/** Password input with a Show/Hide toggle and an optional length meter. */
export function PasswordField({ label, value, onChange, error, minLength, labelEnd, ...rest }: Props) {
  const id = useId()
  const [show, setShow] = useState(false)
  const len = value.length
  const ok = minLength !== undefined && len >= minLength
  const hint = minLength === undefined ? null : len === 0 ? `${minLength} characters min` : ok ? 'Good length' : `${minLength - len} more to go`
  return (
    <div className={s.field}>
      <div className={s.labelRow}>
        <label htmlFor={id} className={s.label}>{label}</label>
        {labelEnd}
      </div>
      <div className={s.wrap}>
        <input
          {...rest}
          id={id}
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={`${s.control} ${error ? s.invalid : ''}`}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-err` : undefined}
        />
        <button type="button" className={s.toggle} onClick={() => setShow((v) => !v)} aria-pressed={show}>
          {show ? 'Hide' : 'Show'}<span className="visually-hidden"> password</span>
        </button>
      </div>
      {minLength !== undefined && (
        <div className={s.meter}>
          <div className={s.track}><div className={`${s.fill} ${ok ? s.fillOk : ''}`} style={{ width: `${Math.min(100, Math.round((len / minLength) * 100))}%` }} /></div>
          <span className={s.meterHint}>{hint}</span>
        </div>
      )}
      {error && <span id={`${id}-err`} className={s.error} role="alert">{error}</span>}
    </div>
  )
}
