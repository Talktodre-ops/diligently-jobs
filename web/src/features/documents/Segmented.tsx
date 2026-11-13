import s from './Segmented.module.css'

type Option<T extends string> = { value: T; label: string }

/** Two or three mutually exclusive views, as pressed toggle buttons. */
export function Segmented<T extends string>({ label, options, value, onChange }: { label: string; options: Option<T>[]; value: T; onChange: (v: T) => void }) {
  return (
    <div role="group" aria-label={label} className={s.group}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} className={s.option} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}
