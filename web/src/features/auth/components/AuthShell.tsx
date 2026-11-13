import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Icon } from '../../../ui/Icon'
import { BrandArt } from './BrandArt'
import s from './AuthShell.module.css'

type Props = {
  children: ReactNode
  /** Where the back arrow goes; omit for no back link. */
  back?: string
  backState?: unknown
  /** Sticky bottom bar (primary action on onboarding screens). */
  footer?: ReactNode
  /** Replaces the brand art in the desktop side panel. */
  aside?: ReactNode
  /** Wider content column (used by the Check screen). */
  wide?: boolean
  /** Shown above the heading, in the content column (onboarding progress). */
  top?: ReactNode
  /** Replaces the brand art and also shows on a phone, as a band above the form (sign up). */
  intro?: ReactNode
}

/**
 * Frame shared by every auth and onboarding screen. On a phone it is a single
 * column; from 900px the aubergine side panel appears and the form sits beside it.
 */
export function AuthShell({ children, back, backState, footer, aside, wide, top, intro }: Props) {
  return (
    <div className={s.page}>
      <aside className={`${s.brand} ${intro ? s.band : ''}`}>
        <div className={s.wordmark}>
          diligently<span className={s.dot}>.</span>
        </div>
        {intro ?? aside ?? (
          <>
            <BrandArt />
            <p className={s.tagline} aria-hidden="true">Paste a job. Get a tailored CV, a match score and a cover letter.</p>
          </>
        )}
      </aside>
      <div className={s.pane}>
        <header className={`${s.head} ${intro && !back && !top ? s.headEmpty : ''}`}>
          {back && (
            <Link to={back} state={backState} className={s.back} aria-label="Back">
              <Icon name="back" size={22} strokeWidth={2} />
            </Link>
          )}
          {top && <div className={s.top}>{top}</div>}
        </header>
        <main className={`${s.main} ${wide ? s.wide : ''}`}>{children}</main>
        {footer && (
          <footer className={s.footer}>
            <div className={`${s.footerInner} ${wide ? s.wide : ''}`}>{footer}</div>
          </footer>
        )}
      </div>
    </div>
  )
}
