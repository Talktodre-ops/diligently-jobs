import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Icon } from './Icon'
import s from './TopBar.module.css'

type Props = { back?: string; backLabel?: string; eyebrow?: ReactNode; title: ReactNode; end?: ReactNode }

/** The header used by every pushed screen: back, two-line title, actions. */
export function TopBar({ back, backLabel = 'Back', eyebrow, title, end }: Props) {
  return (
    <header className={s.bar}>
      {back && (
        <Link to={back} className={s.back} aria-label={backLabel}>
          <Icon name="back" size={22} strokeWidth={2} />
        </Link>
      )}
      <div className={s.titles}>
        {eyebrow && <div className={s.eyebrow}>{eyebrow}</div>}
        <h1 className={s.title}>{title}</h1>
      </div>
      {end && <div className={s.end}>{end}</div>}
    </header>
  )
}
