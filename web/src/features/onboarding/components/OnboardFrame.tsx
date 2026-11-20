import { LogoMark } from '../../../ui/LogoMark'
import { useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, Navigate, useNavigate } from 'react-router'
import { profileKey, useMe, useProfile } from '../../../auth/session'
import { Icon } from '../../../ui/Icon'
import { PageState } from '../../../ui/PageState'
import type { OnboardingStep } from '../../../api/types'
import { toFormError } from '../../auth/errors'
import { Notice } from '../../../ui/Notice'
import { stepOrder, stepPath, useFinishOnboarding, type FlowStep } from '../api'
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
 * Wraps an onboarding screen: sends unverified users to verify first and,
 * during the guided first run, never lets someone jump ahead of their saved
 * step. Every step can wait: "Do this later" ends the guided run and goes
 * Home, where the setup card holds what is left. Once the guided run is over
 * the same screens open from that card, one at a time.
 * Phone: progress bars and a single column. Desktop (from 1024px): the brand
 * header with the labelled steps, the form on the left and the CV filling the
 * rest of the width on the right.
 */
export function OnboardFrame({ step, back, footer, aside, asideLabel = 'Your CV', finishing, children }: Props) {
  const me = useMe()
  const profile = useProfile(!!me.data?.email_verified)
  const later = useLater(profile.data?.onboarding_step)
  if (me.isPending) return <PageState.Loading />
  if (me.data && !me.data.email_verified) return <Navigate to="/verify-email" replace />
  if (profile.isPending) return <PageState.Loading />
  if (profile.isError) return <PageState.Error error={profile.error} onRetry={() => profile.refetch()} />
  const saved = profile.data.onboarding_step
  if (saved !== 'done' && !finishing && stepOrder.indexOf(saved) < stepOrder.indexOf(step)) return <Navigate to={stepPath[saved]} replace />

  const n = steps.indexOf(step)
  return (
    <div className={s.page}>
      <header className={s.head}>
        {back && (
          <Link to={back} className={s.back} aria-label="Back">
            <Icon name="back" size={22} strokeWidth={2} />
          </Link>
        )}
        <div className={s.brand} aria-hidden="true"><LogoMark />diligently<span className={s.dot}>.</span></div>
        <ol className={s.steps} aria-label="Setup steps">
          {steps.map((st, i) => (
            <li key={st} className={`${s.step} ${i < n ? s.past : i === n ? s.now : ''}`} aria-current={i === n ? 'step' : undefined}>
              <span className={s.bar} aria-hidden="true" />
              <span className={s.stepName}>{labels[st]}</span>
            </li>
          ))}
        </ol>
        <div className={s.meta}>
          <span><span className={s.nowName} aria-hidden="true">{labels[step]} &middot; </span>{saved === 'done' ? 'Finish any time' : timeLeft[step]}</span>
          <button type="button" className={s.later} disabled={later.busy} onClick={later.go}>Do this later</button>
        </div>
      </header>
      {later.error && <div className={s.laterError}><Notice tone="error">{later.error}</Notice></div>}
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

/**
 * "Do this later": during the guided run, mark it over (so Home stops sending
 * the user back here) and go Home; afterwards, just go Home.
 */
function useLater(saved: OnboardingStep | undefined) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const finish = useFinishOnboarding()
  const [error, setError] = useState<string | null>(null)
  async function go() {
    setError(null)
    if (saved === 'done') return navigate('/')
    try {
      qc.setQueryData(profileKey, await finish.mutateAsync())
      navigate('/', { replace: true })
    } catch (e) {
      setError(toFormError(e).message)
    }
  }
  return { go: () => void go(), busy: finish.isPending, error }
}
