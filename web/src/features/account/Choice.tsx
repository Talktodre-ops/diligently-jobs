import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import s from './SettingsPage.module.css'

export type ChoiceOption<T> = { value: T; label: ReactNode; sub?: string }

type Props<T> = {
  value: T
  options: ChoiceOption<T>[]
  onPick: (v: T) => void
  /** id of the visible label, or a plain label when there is none on screen. */
  labelledBy?: string
  label?: string
}

/**
 * A segmented choice that behaves like a radio group: one tab stop, arrow keys
 * move and pick, Home and End jump to the ends.
 */
export function Choice<T extends string | number>({ value, options, onPick, labelledBy, label }: Props<T>) {
  const ref = useRef<HTMLDivElement>(null)
  const at = options.findIndex((o) => o.value === value)
  const focusIndex = at < 0 ? 0 : at

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const last = options.length - 1
    const next =
      e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (i === last ? 0 : i + 1)
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (i === 0 ? last : i - 1)
          : e.key === 'Home' ? 0
            : e.key === 'End' ? last
              : null
    if (next === null) return
    e.preventDefault()
    ref.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus()
    onPick(options[next]!.value)
  }

  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : label}
      className={s.choice}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((o, i) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={i === focusIndex ? 0 : -1}
          className={s.choiceBtn}
          onClick={() => o.value !== value && onPick(o.value)}
          onKeyDown={(e) => onKey(e, i)}
        >
          <span>{o.label}</span>
          {o.sub && <span className={s.choiceSub}>{o.sub}</span>}
        </button>
      ))}
    </div>
  )
}
