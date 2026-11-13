import { useState } from 'react'
import { Link } from 'react-router'
import { Icon } from '../../ui/Icon'
import { useMoveReminder, type Reminder } from './api'
import { shortDate } from './format'
import s from './Send.module.css'

const CHOICES = [5, 7, 10] as const

type Props = { company: string; role: string | null; score: number | null; reminder: Reminder | null; initialDays: number }

/** "Applied." with the follow-up reminder, which the person can move to 5 or 10 days. */
export function SendDone({ company, role, score, reminder: first, initialDays }: Props) {
  const move = useMoveReminder()
  const [reminder, setReminder] = useState(first)
  const [days, setDays] = useState(initialDays)

  const pick = (d: number) => {
    if (!reminder || d === days || move.isPending) return
    const previous = days
    setDays(d)
    move.mutate(
      { reminderId: reminder.id, days: d },
      { onSuccess: ({ reminder: r }) => setReminder(r), onError: () => setDays(previous) },
    )
  }

  const what = [company, role].filter(Boolean).join(', ')
  return (
    <main className={s.done}>
      <div className={s.doneInner}>
        <div className={s.tick} aria-hidden="true"><Icon name="check" size={38} strokeWidth={2.4} /></div>
        <h1 className={s.doneTitle}>Applied.</h1>
        <p className={s.doneText}>{what}{score != null ? `, sent with a match of ${score}.` : ', marked as sent.'}</p>
        {reminder && (
          <div className={s.remind}>
            <div className={s.remindLabel} id="remind-label">Remind me to follow up in</div>
            <div className={s.remindChoices} role="group" aria-labelledby="remind-label">
              {CHOICES.map((d) => (
                <button key={d} type="button" className={s.remindChip} aria-pressed={days === d} onClick={() => pick(d)} disabled={move.isPending && days !== d}>
                  {d} days
                </button>
              ))}
            </div>
            <p className={s.remindText} role="status" aria-live="polite">
              {move.isError
                ? `That did not save: ${move.error.message}`
                : move.isPending
                  ? 'Moving your reminder.'
                  : `We will nudge you on ${shortDate(reminder.due_at)} with a draft ready.`}
            </p>
          </div>
        )}
        <div className={s.doneLinks}>
          <Link to="/" className={s.homeLink}>Back home</Link>
          <Link to="/new" className={s.againLink}>Apply to another job</Link>
        </div>
      </div>
    </main>
  )
}
