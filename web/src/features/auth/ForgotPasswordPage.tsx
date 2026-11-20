import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { Button, ButtonLink } from '../../ui/Button'
import { Icon } from '../../ui/Icon'
import { Notice } from '../../ui/Notice'
import { TextField } from '../../ui/TextField'
import { authApi } from './api'
import { AuthShell } from './components/AuthShell'
import { toFormError } from './errors'
import s from './auth.module.css'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!email.trim() || !email.includes('@')) {
      setError('Enter the email address you signed up with.')
      return
    }
    setError(null)
    setBusy(true)
    try {
      await authApi.forgotPassword(email.trim())
      setSentTo(email.trim())
    } catch (err) {
      setError(toFormError(err).message)
    } finally {
      setBusy(false)
    }
  }

  if (sentTo) {
    return (
      <AuthShell back="/signin">
        <div className={s.mark} aria-hidden="true"><Icon name="check" size={34} strokeWidth={2} /></div>
        <h1 className={s.title}>Link sent</h1>
        <p className={s.lede} role="status">If an account exists for <strong>{sentTo}</strong>, the reset link is on its way.</p>
        <ButtonLink to="/signin" variant="secondary" block>Back to sign in</ButtonLink>
      </AuthShell>
    )
  }

  return (
    <AuthShell back="/signin">
      <div className={s.heading}>
        <h1 className={s.title}>Reset your password</h1>
        <p className={s.lede}>We will email you a link. It works once and expires in an hour.</p>
      </div>
      <form className={s.form} onSubmit={submit} noValidate>
        {error && <Notice tone="error">{error}</Notice>}
        <TextField label="Email" type="email" autoComplete="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Button type="submit" variant="dark" busy={busy} block>Send reset link</Button>
      </form>
      <p className={s.foot}><Link to="/signin">Back to sign in</Link></p>
    </AuthShell>
  )
}
