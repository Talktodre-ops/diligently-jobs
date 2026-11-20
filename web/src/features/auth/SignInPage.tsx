import { useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router'
import { useResetSession } from '../../auth/session'
import { Button } from '../../ui/Button'
import { Notice } from '../../ui/Notice'
import { TextField } from '../../ui/TextField'
import { authApi } from './api'
import { AuthShell } from './components/AuthShell'
import { GoogleButton } from './components/GoogleButton'
import { PasswordField } from './components/PasswordField'
import { toFormError } from './errors'
import s from './auth.module.css'

/** Where to go after signing in: the page the gates bounced the visitor from, else home. */
function destination(state: unknown): string {
  const from = (state as { from?: unknown } | null)?.from
  return typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') ? from : '/'
}

export default function SignInPage() {
  const navigate = useNavigate()
  const { state } = useLocation()
  const [params] = useSearchParams()
  const resetSession = useResetSession()
  // The API sends a failed Google round trip back here without saying why.
  const googleFailed = params.get('error') === 'google'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!email.trim() || !password) {
      setError('Enter your email and password.')
      return
    }
    setError(null)
    setBusy(true)
    try {
      const user = await authApi.signIn({ email: email.trim(), password })
      await resetSession(user)
      navigate(destination(state), { replace: true })
    } catch (err) {
      setError(toFormError(err).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthShell back="/welcome" backState={state}>
      <div className={s.heading}>
        <h1 className={s.title}>Welcome back</h1>
        <p className={s.lede}>Pick up where you left off.</p>
      </div>
      {googleFailed && !error && <Notice tone="error">Google sign-in did not work. Try again, or use your email and password.</Notice>}
      <GoogleButton next={destination(state)} />
      <form className={s.form} onSubmit={submit} noValidate>
        {error && <Notice tone="error">{error}</Notice>}
        <TextField
          label="Email"
          type="email"
          autoComplete="email"
          inputMode="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <PasswordField
          label="Password"
          autoComplete="current-password"
          value={password}
          onChange={setPassword}
          labelEnd={<Link to="/forgot-password" className={`${s.textLink} ${s.small}`}>Forgot password?</Link>}
        />
        <Button type="submit" busy={busy} block>Sign in</Button>
      </form>
      <p className={s.foot}>
        New here? <Link to="/signup" state={state}>Create an account</Link>
      </p>
    </AuthShell>
  )
}
