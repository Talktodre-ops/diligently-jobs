import type { ReactNode } from 'react'
import { Link, Navigate } from 'react-router'
import { useMe, useProfile } from '../../../auth/session'
import { Icon } from '../../../ui/Icon'
import { PageState } from '../../../ui/PageState'
import { stepOrder, stepPath, type FlowStep } from '../api'
import s from './OnboardFrame.module.css'

const steps: FlowStep[] = ['upload', 'check', 'targets', 'first_job']
const labels: Record<FlowStep, string> = { upload: 'Your CV', check: 'Check', targets: 'What you want', first_job: 'First job' }
const timeLeft: Record<FlowStep, string> = {
  upload: 'About 3 minutes left',
  check: 'About 2 minutes left',
  targets: 'About a minute left',
  first_job: 'Last step',
}

type Props = {
  step: FlowStep
  back?: string
  /** The primary action: a sticky bar on a phone, inline under the form on a desktop. */
  footer?: ReactNode
  /** The right-hand pane on a desktop (the user's CV). Not shown on a phone. */
  aside?: ReactNode
  asideLabel?: string
  /** The screen is marking onboarding done and navigating away itself: do not redirect Home meanwhile. */
  finishing?: boolean
  children: ReactNode
}

/**
 * Wraps an onboarding screen: sends unverified users to verify first, sends
 * finished users home, and never lets someone jump ahead of their saved step.
 * Phone: progress bars and a single column. Desktop (from 1024px): the brand
 * header with the labelled steps, the form on the left and the CV filling the
 * rest of the width on the right.
 */
export function OnboardFrame({ step, back, footer, aside, asideLabel = 'Your CV', finishing, children }: Props) {
  const me = useMe()
  const profile = useProfile(!!me.data?.email_verified)
  if (me.isPending) return <PageState.Loading />
  if (me.data && !me.data.email_verified) return <Navigate to="/verify-email" replace />
  if (profile.isPending) return <PageState.Loading />
  if (profile.isError) return <PageState.Error error={profile.error} onRetry={() => profile.refetch()} />
  const saved = profile.data.onboarding_step
  if (saved === 'done' && !finishing) return <Navigate to="/" replace />
  if (saved !== 'done' && stepOrder.indexOf(saved) < stepOrder.indexOf(step)) return <Navigate to={stepPath[saved]} replace />

  const n = steps.indexOf(step)
  return (
    <div className={s.page}>
      <header className={s.head}>
        {back && (
          <Link to={back} className={s.back} aria-label="Back">
            <Icon name="back" size={22} strokeWidth={2} />
          </Link>
        )}
        <div className={s.brand} aria-hidden="true">diligently<span className={s.dot}>.</span></div>
        <ol className={s.steps} aria-label="Setup steps">
          {steps.map((st, i) => (
            <li key={st} className={`${s.step} ${i < n ? s.past : i === n ? s.now : ''}`} aria-current={i === n ? 'step' : undefined}>
              <span className={s.bar} aria-hidden="true" />
              <span className={s.stepName}>{labels[st]}</span>
            </li>
          ))}
        </ol>
        <div className={s.meta}>
          <span className={s.nowName} aria-hidden="true">{labels[step]}</span>
          <span>{timeLeft[step]}</span>
        </div>
      </header>
      <div className={s.body}>
        <div className={s.formPane}>
          <main className={s.main}>{children}</main>
          {footer && <div className={s.footer}>{footer}</div>}
        </div>
        {aside && (
          <aside className={s.cvPane} aria-label={asideLabel}>
            {aside}
          </aside>
        )}
      </div>
    </div>
  )
}
