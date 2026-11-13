import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router'
import { meKey, useMe } from '../../auth/session'
import { ButtonLink } from '../../ui/Button'
import { Icon } from '../../ui/Icon'
import { PageState } from '../../ui/PageState'
import { authApi } from './api'
import { AuthShell } from './components/AuthShell'
import { toFormError } from './errors'
import s from './auth.module.css'

type Phase = { name: 'working' } | { name: 'ok' } | { name: 'failed'; message: string; invalid: boolean }

/** The link in the "confirm your new address" email lands here. */
export default function ConfirmEmailPage() {
  const [params] = useSearchParams()
  const token = params.get('token')
  const qc = useQueryClient()
  const me = useMe()
  const [phase, setPhase] = useState<Phase>({ name: 'working' })
  const started = useRef(false)

  useEffect(() => {
    if (!token || started.current) return
    started.current = true
    authApi
      .confirmEmail(token)
      .then(async () => {
        await qc.invalidateQueries({ queryKey: meKey })
        setPhase({ name: 'ok' })
      })
      .catch((err) => {
        const f = toFormError(err)
        setPhase({ name: 'failed', message: f.message, invalid: f.code === 'token_invalid' })
      })
  }, [token, qc])

  const signedIn = !!me.data

  if (!token) {
    return (
      <AuthShell>
        <h1 className={s.title}>This link is incomplete</h1>
        <p className={s.lede}>Open the link from your email again.</p>
        <ButtonLink to="/" block>Go home</ButtonLink>
      </AuthShell>
    )
  }
  if (phase.name === 'working') return <PageState.Loading label="Confirming your new address" />
  if (phase.name === 'failed') {
    return (
      <AuthShell>
        <h1 className={s.title}>{phase.invalid ? 'That link has expired' : 'We could not confirm that'}</h1>
        <p className={s.lede} role="alert">
          {phase.invalid ? 'It may have been used already. Request the change again from Settings.' : phase.message}
        </p>
        <ButtonLink to={signedIn ? '/settings' : '/signin'} block>{signedIn ? 'Open settings' : 'Sign in'}</ButtonLink>
      </AuthShell>
    )
  }
  return (
    <AuthShell>
      <div className={s.mark} aria-hidden="true"><Icon name="check" size={34} strokeWidth={2} /></div>
      <h1 className={s.title}>Address confirmed</h1>
      <p className={s.lede} role="status">Your sign-in email has been updated.</p>
      <ButtonLink to={signedIn ? '/' : '/signin'} block>{signedIn ? 'Continue' : 'Sign in'}</ButtonLink>
      {!signedIn && <p className={s.foot}><Link to="/welcome">Back to start</Link></p>}
    </AuthShell>
  )
}
