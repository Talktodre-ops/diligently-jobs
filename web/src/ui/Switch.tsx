import s from './Switch.module.css'

/** An on/off switch. The visible row text is its label. */
export function Switch({ checked, onChange, label, id }: { checked: boolean; onChange: (next: boolean) => void; label: string; id?: string }) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={s.track}
      onClick={() => onChange(!checked)}
    >
      <span className={s.knob} />
    </button>
  )
}
