import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router'
import { isApiError } from '../../api/client'
import type { User } from '../../api/types'
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
  return token ? <VerifyToken token={token} /> : <CodeEntry />
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

/** "0:42" */
function clock(secs: number) {
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
}

/** What to say for each failure the code endpoint can give. */
function codeError(err: unknown): string {
  if (isApiError(err, 'invalid_code')) return 'That code is not right. Check the newest email from us and try again.'
  if (isApiError(err, 'code_expired')) return 'That code has expired or was used too many times. Send a new code and use the newest email.'
  return toFormError(err).message
}

const RESEND_WAIT = 60

/** Signed up but not yet verified: type the 6-digit code from the email (the link in it works too). */
function CodeEntry() {
  const me = useMe()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { state } = useLocation()
  const resetSession = useResetSession()
  const justSent = !!(state as { codeSent?: boolean } | null)?.codeSent
  const { secs, start } = useCooldown(justSent ? RESEND_WAIT : 0)
  const [code, setCode] = useState('')
  const [checking, setChecking] = useState(false)
  const [verified, setVerified] = useState<User | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [resending, setResending] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  function carryOn() {
    // Write the verified user and leave in the same tick; the gates send them to their onboarding step.
    qc.setQueryData(meKey, verified)
    navigate('/', { replace: true })
  }

  if (verified) {
    return (
      <AuthShell footer={<Button block autoFocus onClick={carryOn}>Continue</Button>}>
        <CodeHeading email={verified.email} />
        <p className={s.verified} role="status">
          <Icon name="check" size={18} strokeWidth={2.4} className={s.verifiedIcon} />
          Verified. On to your CV.
        </p>
      </AuthShell>
    )
  }
  if (me.isPending) return <PageState.Loading />
  if (me.isError) return <PageState.Error error={me.error} onRetry={() => me.refetch()} />
  if (!me.data) return <Navigate to="/welcome" replace />
  if (me.data.email_verified) return <Navigate to="/" replace />

  async function check(value: string) {
    if (checking) return
    setChecking(true)
    setError(null)
    setNote(null)
    try {
      setVerified(await authApi.verifyCode(value))
    } catch (err) {
      if (isApiError(err) && err.status === 429 && err.retryAfter) start(err.retryAfter)
      setError(codeError(err))
      setChecking(false)
      // Leave the digits there but selected, so typing again replaces them.
      requestAnimationFrame(() => input.current?.select())
    }
  }

  function onCode(raw: string) {
    const digits = raw.replace(/\D/g, '').slice(0, 6)
    setCode(digits)
    if (error) setError(null)
    if (digits.length === 6) void check(digits)
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (code.length < 6) return setError('Enter all 6 digits from the email.')
    void check(code)
  }

  async function resend() {
    setResending(true)
    setError(null)
    setNote(null)
    try {
      await authApi.resendVerification()
      setNote('Sent. Use the code in the newest email; the old one no longer works.')
      setCode('')
      start(RESEND_WAIT)
    } catch (err) {
      if (isApiError(err) && err.status === 429 && err.retryAfter) start(err.retryAfter)
      setError(toFormError(err).message)
    } finally {
      setResending(false)
    }
  }

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

  const errorId = 'code-error'
  return (
    <AuthShell>
      <CodeHeading email={me.data.email} />
      <form className={s.codeForm} onSubmit={onSubmit} noValidate>
        <label htmlFor="code" className={s.codeLabel}>Code</label>
        <input
          ref={input}
          id="code"
          name="code"
          className={`${s.code} ${error ? s.codeInvalid : ''} ${code.length === 6 ? s.codeFull : ''}`}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={6}
          placeholder="000000"
          autoFocus
          value={code}
          onChange={(e) => onCode(e.target.value)}
          readOnly={checking}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
        />
        <div aria-live="polite" className={s.codeStatus}>
          {checking && <span role="status">Checking the code</span>}
          {error && <span id={errorId} className={s.codeError} role="alert">{error}</span>}
          {note && !error && <span className={s.ok} role="status">{note}</span>}
        </div>
      </form>

      <div className={s.mailApps}>
        <a className={s.mailApp} href="https://mail.google.com/" target="_blank" rel="noopener noreferrer">Open Gmail</a>
        <a className={s.mailApp} href="https://outlook.live.com/mail/" target="_blank" rel="noopener noreferrer">Open Outlook</a>
      </div>

      <div className={s.help}>
        <div>
          Nothing yet?{' '}
          <button type="button" className={s.textLink} onClick={resend} disabled={secs > 0 || resending}>Send a new code</button>
          {secs > 0 && <span> in {clock(secs)}</span>}
        </div>
        <div>
          Wrong address?{' '}
          <button type="button" className={s.textLink} onClick={() => leave('/signup')} disabled={leaving}>Change it</button>
        </div>
      </div>
    </AuthShell>
  )
}

function CodeHeading({ email }: { email: string }) {
  return (
    <div className={s.heading}>
      <h1 className={s.title}>Check your email</h1>
      <p className={s.lede}>
        We sent a 6-digit code to <strong>{email}</strong>. Type it here and keep going. The link in the email works too.
      </p>
    </div>
  )
}
