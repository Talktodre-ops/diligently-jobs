import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Navigate, useNavigate, useSearchParams } from 'react-router'
import { isApiError } from '../../api/client'
import { meKey, useMe, useResetSession } from '../../auth/session'
import { Button, ButtonLink } from '../../ui/Button'
import { Icon } from '../../ui/Icon'
import { PageState } from '../../ui/PageState'
import { authApi } from './api'
import { AuthShell } from './components/AuthShell'
import { useCooldown } from './components/useCooldown'
import { toFormError } from './errors'
import s from './auth.module.css'

export default function VerifyEmailPage() {
  const [params] = useSearchParams()
  const token = params.get('token')
  return token ? <VerifyToken token={token} /> : <Inbox />
}

type Phase = { name: 'working' } | { name: 'ok' } | { name: 'failed'; invalid: boolean; message: string }

/** The emailed link: post the token, refresh the user, then carry on. */
function VerifyToken({ token }: { token: string }) {
  const qc = useQueryClient()
  const me = useMe()
  const [phase, setPhase] = useState<Phase>({ name: 'working' })
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    authApi
      .verify(token)
      .then(async () => {
        await qc.invalidateQueries({ queryKey: meKey })
        setPhase({ name: 'ok' })
      })
      .catch((err) => {
        const f = toFormError(err)
        setPhase({ name: 'failed', invalid: f.code === 'token_invalid', message: f.message })
      })
  }, [token, qc])

  if (phase.name === 'working' || me.isPending) return <PageState.Loading label="Confirming your email" />
  const signedIn = !!me.data

  if (phase.name === 'ok') {
    // The gates take it from here: a verified account goes on to the next onboarding step.
    if (signedIn) return <Navigate to="/" replace />
    return (
      <AuthShell>
        <div className={s.mark} aria-hidden="true"><Icon name="check" size={34} strokeWidth={2} /></div>
        <h1 className={s.title}>Email confirmed</h1>
        <p className={s.lede} role="status">Sign in to carry on with your account.</p>
        <ButtonLink to="/signin" block>Sign in</ButtonLink>
      </AuthShell>
    )
  }

  return (
    <AuthShell>
      <h1 className={s.title}>{phase.invalid ? 'That link has expired' : 'We could not confirm that'}</h1>
      <p className={s.lede} role="alert">
        {phase.invalid ? 'It may be older than a day or already used.' : phase.message}
      </p>
      {signedIn ? (
        <Resender label="Send me a new link" />
      ) : (
        <>
          <p className={s.lede}>Sign in and we can send you a fresh one.</p>
          <ButtonLink to="/signin" state={{ from: '/verify-email' }} block>Sign in</ButtonLink>
        </>
      )}
    </AuthShell>
  )
}

/** Resend the verification email, with a cooldown that also honours a 429's Retry-After. */
function useResend() {
  const { secs, start } = useCooldown()
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function resend() {
    setBusy(true)
    setError(null)
    try {
      await authApi.resendVerification()
      setSent(true)
      start(30)
    } catch (err) {
      setSent(false)
      if (isApiError(err) && err.status === 429 && err.retryAfter) start(err.retryAfter)
      setError(toFormError(err).message)
    } finally {
      setBusy(false)
    }
  }
  return { secs, sent, error, busy, resend, setError }
}

function Resender({ label }: { label: string }) {
  const { secs, sent, error, busy, resend } = useResend()
  return (
    <div className={s.stack}>
      <Button onClick={resend} busy={busy} disabled={secs > 0} block variant="dark">
        {secs > 0 ? `${label} (${secs}s)` : label}
      </Button>
      <div aria-live="polite">
        {sent && !error && <p className={`${s.help} ${s.ok}`}>Sent a fresh link.</p>}
        {error && <p className={s.help} role="alert">{error}</p>}
      </div>
    </div>
  )
}

/** Signed up but not yet verified: tell them to check their inbox. */
function Inbox() {
  const me = useMe()
  const navigate = useNavigate()
  const resetSession = useResetSession()
  const { secs, sent, error, busy, resend, setError } = useResend()
  const [leaving, setLeaving] = useState(false)

  if (me.isPending) return <PageState.Loading />
  if (me.isError) return <PageState.Error error={me.error} onRetry={() => me.refetch()} />
  if (!me.data) return <Navigate to="/welcome" replace />
  if (me.data.email_verified) return <Navigate to="/" replace />

  async function leave(to: string) {
    setLeaving(true)
    try {
      await authApi.signOut()
    } catch (err) {
      // A session that already ended is the state we wanted anyway.
      if (!isApiError(err, 'unauthorized')) {
        setError(toFormError(err).message)
        setLeaving(false)
        return
      }
    }
    await resetSession(null)
    navigate(to, { replace: true })
  }

  return (
    <AuthShell>
      <div className={`${s.mark} ${s.markBig}`} aria-hidden="true">
        <Icon name="mail" size={44} strokeWidth={1.6} />
        <span className={s.ping} />
      </div>
      <div className={s.heading}>
        <h1 className={s.title}>Check your email</h1>
        <p className={s.lede}>
          We sent a link to <strong>{me.data.email}</strong>. Tap it on this device and you will land straight in your account.
        </p>
      </div>
      <div className={s.help}>
        <div>
          Nothing yet? Check spam, or{' '}
          {secs > 0 ? (
            <span>send it again in {secs}s.</span>
          ) : (
            <button type="button" className={s.textLink} onClick={resend} disabled={busy}>send it again</button>
          )}
        </div>
        <div aria-live="polite">
          {sent && !error && <span className={s.ok}>Sent a fresh link.</span>}
          {error && <span role="alert">{error}</span>}
        </div>
        <div>
          Wrong address?{' '}
          <button type="button" className={s.textLink} onClick={() => leave('/signup')} disabled={leaving}>Start again with another one</button>
        </div>
        <div>
          <button type="button" className={s.textLink} onClick={() => leave('/welcome')} disabled={leaving}>Sign out</button>
        </div>
      </div>
    </AuthShell>
  )
}
