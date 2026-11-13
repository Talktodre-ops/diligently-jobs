import { Link } from 'react-router'
import { ButtonLink } from '../../ui/Button'
import { Icon } from '../../ui/Icon'
import { companyName } from '../apply/api'
import { dueLabel, plural } from '../apply/format'
import type { NeedsYouCard } from './api'
import s from './HomePage.module.css'

function title(c: NeedsYouCard) {
  return [companyName(c.company), c.role].filter(Boolean).join(' · ')
}

/** The action cards at the top of Home: follow-ups first, then unfinished work. */
export function NeedsYou({ cards, desktop }: { cards: NeedsYouCard[]; desktop: boolean }) {
  if (cards.length === 0) {
    if (!desktop) return null
    return (
      <section aria-labelledby="needs-you" className={s.section}>
        <h2 id="needs-you" className={s.h2}>Needs you</h2>
        <p className={s.quiet}>Nothing right now. New follow-ups and unfinished applications show up here.</p>
      </section>
    )
  }
  return (
    <section aria-labelledby="needs-you" className={s.section}>
      <h2 id="needs-you" className={desktop ? s.h2 : 'visually-hidden'}>Needs you</h2>
      <ul className={s.cards}>
        {cards.map((c) => (
          <li key={`${c.type}-${c.application_id}-${c.reminder_id ?? ''}`}>
            <Card card={c} />
          </li>
        ))}
      </ul>
    </section>
  )
}

function Card({ card: c }: { card: NeedsYouCard }) {
  if (c.type === 'follow_up') {
    return (
      <div className={s.followUp}>
        <div className={s.followText}>
          <div className={s.eyebrowRow}>
            <Icon name="calendar" size={16} strokeWidth={2} />
            Follow-up due
          </div>
          <div className={s.cardTitle}>{companyName(c.company)}</div>
          <div className={s.cardSub}>{[c.role, c.due_at && dueLabel(c.due_at)].filter(Boolean).join(' · ')}</div>
        </div>
        <ButtonLink to={`/applications/${c.application_id}/follow-up`} variant="dark" small>
          Draft follow-up
        </ButtonLink>
      </div>
    )
  }
  const view = {
    review: {
      eyebrow: 'Unfinished',
      sub: `${plural(c.pending ?? 0, 'rewrite')} left to review`,
      to: `/applications/${c.application_id}`,
    },
    retry: {
      eyebrow: 'Stopped',
      sub: 'Tailoring did not finish. Try it again.',
      to: `/applications/${c.application_id}/running`,
    },
    prepare: {
      eyebrow: 'Interview',
      sub: 'Read the company research before you go in',
      to: `/applications/${c.application_id}/research`,
    },
  }[c.type]
  return (
    <Link to={view.to} className={s.rowCard}>
      <div className={s.rowText}>
        <div className={s.eyebrowAccent}>{view.eyebrow}</div>
        <div className={s.rowTitle}>{title(c)}</div>
        <div className={s.rowSub}>{view.sub}</div>
      </div>
      <Icon name="forward" size={20} strokeWidth={2} />
    </Link>
  )
}
