import type { ReactNode } from 'react'
import { Navigate } from 'react-router'
import { useMe, useProfile } from '../../../auth/session'
import { PageState } from '../../../ui/PageState'
import { AuthShell } from '../../auth/components/AuthShell'
import { stepOrder, stepPath } from '../api'
import s from './OnboardFrame.module.css'

type Step = 'upload' | 'check' | 'targets'
const labels: Record<Step, string> = { upload: 'Your CV', check: 'Check it', targets: 'What you want' }
const steps: Step[] = ['upload', 'check', 'targets']

type Props = { step: Step; back?: string; footer?: ReactNode; wide?: boolean; children: ReactNode }

/**
 * Wraps an onboarding screen: sends unverified users to verify first, sends
 * finished users home, and never lets someone jump ahead of their saved step.
 */
export function OnboardFrame({ step, back, footer, wide, children }: Props) {
  const me = useMe()
  const profile = useProfile(!!me.data?.email_verified)
  if (me.isPending) return <PageState.Loading />
  if (me.data && !me.data.email_verified) return <Navigate to="/verify-email" replace />
  if (profile.isPending) return <PageState.Loading />
  if (profile.isError) return <PageState.Error error={profile.error} onRetry={() => profile.refetch()} />
  const saved = profile.data.onboarding_step
  if (saved === 'done') return <Navigate to="/" replace />
  if (stepOrder.indexOf(saved) < stepOrder.indexOf(step)) return <Navigate to={stepPath[saved]} replace />

  const n = steps.indexOf(step)
  const top = (
    <div className={s.progress}>
      <div className={s.bars} aria-hidden="true">
        {steps.map((st, i) => (
          <span key={st} className={`${s.bar} ${i < n ? s.past : i === n ? s.now : ''}`} />
        ))}
      </div>
      <div className={s.count}>Step {n + 1} of 3</div>
    </div>
  )
  const aside = (
    <ol className={s.list} aria-hidden="true">
      {steps.map((st, i) => (
        <li key={st} className={`${s.item} ${i === n ? s.itemNow : ''} ${i < n ? s.itemPast : ''}`}>
          <span className={s.num}>{i + 1}</span>
          <span>{labels[st]}</span>
        </li>
      ))}
    </ol>
  )
  return (
    <AuthShell back={back} top={top} footer={footer} wide={wide} aside={aside}>
      {children}
    </AuthShell>
  )
}
