import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { useResetSession } from '../../auth/session'
import { Button, ButtonLink } from '../../ui/Button'
import { Notice } from '../../ui/Notice'
import { authApi, passwordProblem } from './api'
import { AuthShell } from './components/AuthShell'
import { PasswordField } from './components/PasswordField'
import { toFormError } from './errors'
import s from './auth.module.css'

export default function ResetPasswordPage() {
  const [params] = useSearchParams()
  const token = params.get('token')
  const navigate = useNavigate()
  const resetSession = useResetSession()
  const [password, setPassword] = useState('')
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [formError, setFormError] = useState<{ message: string; expired: boolean } | null>(null)
  const [busy, setBusy] = useState(false)

  if (!token) {
    return (
      <AuthShell back="/signin">
        <h1 className={s.title}>This link is incomplete</h1>
        <p className={s.lede}>Open the link from your reset email again, or ask for a new one.</p>
        <ButtonLink to="/forgot-password" block>Send a new link</ButtonLink>
      </AuthShell>
    )
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    const problem = passwordProblem(password, '')
    setFieldError(problem)
    setFormError(null)
    if (problem || !token) return
    setBusy(true)
    try {
      const user = await authApi.resetPassword({ token, password })
      await resetSession(user)
      navigate('/', { replace: true })
    } catch (err) {
      const f = toFormError(err)
      if (f.field === 'password' && f.code !== 'token_invalid') setFieldError(f.message)
      else setFormError({ message: f.message, expired: f.code === 'token_invalid' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthShell back="/signin">
      <div className={s.heading}>
        <h1 className={s.title}>Choose a new password</h1>
        <p className={s.lede}>You will be signed in on this device. Other devices are signed out.</p>
      </div>
      <form className={s.form} onSubmit={submit} noValidate>
        {formError && (
          <Notice tone="error">
            {formError.message} {formError.expired && <Link to="/forgot-password">Send a new link</Link>}
          </Notice>
        )}
        <PasswordField label="New password" autoComplete="new-password" minLength={10} value={password} onChange={setPassword} error={fieldError} />
        <Button type="submit" busy={busy} block>Save password</Button>
      </form>
    </AuthShell>
  )
}
