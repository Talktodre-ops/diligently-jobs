import { useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { useResetSession } from '../../auth/session'
import { Button } from '../../ui/Button'
import { Notice } from '../../ui/Notice'
import { TextField } from '../../ui/TextField'
import { authApi, passwordProblem } from './api'
import { AuthShell } from './components/AuthShell'
import { PasswordField } from './components/PasswordField'
import { toFormError } from './errors'
import s from './auth.module.css'

type Errors = { email?: string; password?: string; form?: string }

export default function SignUpPage() {
  const navigate = useNavigate()
  const { state } = useLocation()
  const resetSession = useResetSession()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState<Errors>({})
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const next: Errors = {}
    if (!email.trim() || !email.includes('@')) next.email = 'Enter a valid email address.'
    const pw = passwordProblem(password, email)
    if (pw) next.password = pw
    setErrors(next)
    if (next.email || next.password) return
    setBusy(true)
    try {
      const user = await authApi.signUp({ email: email.trim(), password })
      await resetSession(user)
      navigate('/verify-email', { replace: true, state })
    } catch (err) {
      const f = toFormError(err)
      setErrors(f.field === 'email' || f.field === 'password' ? { [f.field]: f.message } : { form: f.message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthShell back="/welcome" backState={state}>
      <div className={s.heading}>
        <h1 className={s.title}>Create your account</h1>
        <p className={s.lede}>Takes a minute. Your CV comes next.</p>
      </div>
      <form className={s.form} onSubmit={submit} noValidate>
        {errors.form && <Notice tone="error">{errors.form}</Notice>}
        <TextField
          label="Email"
          type="email"
          autoComplete="email"
          inputMode="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={errors.email}
        />
        <PasswordField
          label="Password"
          autoComplete="new-password"
          placeholder="At least 10 characters"
          minLength={10}
          value={password}
          onChange={setPassword}
          error={errors.password}
        />
        <Button type="submit" busy={busy} block>Create account</Button>
      </form>
      <p className={s.foot}>
        Already have an account? <Link to="/signin" state={state}>Sign in</Link>
      </p>
    </AuthShell>
  )
}
