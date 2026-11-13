import { useState, type FormEvent } from 'react'
import { isApiError } from '../../api/client'
import { Button } from '../../ui/Button'
import { Notice } from '../../ui/Notice'
import { TextField } from '../../ui/TextField'
import { deleteAccount, useChangeEmail, useChangePassword } from './api'
import { Dialog } from '../../ui/Dialog'
import s from './SettingsPage.module.css'

const fieldMsg = (e: unknown, f: string) => (isApiError(e) && e.field === f ? e.message : null)
const otherMsg = (e: unknown, fields: string[]) =>
  e && !(isApiError(e) && e.field && fields.includes(e.field)) ? (isApiError(e) ? e.message : 'Something went wrong. Try again.') : null

export function ChangeEmailDialog({ current, onClose }: { current: string; onClose: () => void }) {
  const change = useChangeEmail()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const submit = (e: FormEvent) => { e.preventDefault(); change.mutate({ new_email: email.trim(), password }) }
  if (change.isSuccess) {
    return (
      <Dialog title="Check your new inbox" onClose={onClose}>
        <p className={s.body}>We sent a confirmation link to {email.trim()}. Your email stays {current} until you open it.</p>
        <Button onClick={onClose}>Done</Button>
      </Dialog>
    )
  }
  const other = otherMsg(change.error, ['new_email', 'password'])
  return (
    <Dialog title="Change your email" onClose={onClose}>
      <form className={s.dialogForm} onSubmit={submit}>
        <p className={s.body}>We send a confirmation link to the new address. Nothing changes until you open it.</p>
        <TextField label="New email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} error={fieldMsg(change.error, 'new_email')} required />
        <TextField label="Current password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} error={fieldMsg(change.error, 'password')} required />
        {other && <Notice tone="error">{other}</Notice>}
        <div className={s.dialogActions}>
          <Button type="submit" busy={change.isPending}>Send confirmation</Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Dialog>
  )
}

export function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const change = useChangePassword()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const submit = (e: FormEvent) => { e.preventDefault(); change.mutate({ current_password: current, new_password: next }) }
  if (change.isSuccess) {
    return (
      <Dialog title="Password changed" onClose={onClose}>
        <p className={s.body} role="status">Your password is updated. Every other device was signed out.</p>
        <Button onClick={onClose}>Done</Button>
      </Dialog>
    )
  }
  const other = otherMsg(change.error, ['current_password', 'new_password'])
  return (
    <Dialog title="Change your password" onClose={onClose}>
      <form className={s.dialogForm} onSubmit={submit}>
        <p className={s.body}>Changing it signs you out everywhere else. This device stays signed in.</p>
        <TextField label="Current password" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} error={fieldMsg(change.error, 'current_password')} required />
        <TextField label="New password" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} hint="10 to 128 characters." error={fieldMsg(change.error, 'new_password')} required />
        {other && <Notice tone="error">{other}</Notice>}
        <div className={s.dialogActions}>
          <Button type="submit" busy={change.isPending}>Change password</Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Dialog>
  )
}

export function DeleteAccountDialog({ onClose, onDeleted }: { onClose: () => void; onDeleted: () => void }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await deleteAccount(password)
      onDeleted()
    } catch (err) {
      setError(err)
      setBusy(false)
    }
  }
  const other = otherMsg(error, ['password'])
  return (
    <Dialog title="Delete your account?" role="alertdialog" onClose={onClose}>
      <form className={s.dialogForm} onSubmit={submit}>
        <p className={s.body}>This removes your master CV, every tailored CV and letter, and your job history. It cannot be undone. Download your data first if you want a copy.</p>
        <TextField label="Your password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} error={fieldMsg(error, 'password')} hint="Enter it to confirm." required />
        {other && <Notice tone="error">{other}</Notice>}
        <div className={s.dialogActions}>
          <Button type="submit" variant="primary" busy={busy} className={s.danger}>Delete everything</Button>
          <Button variant="quiet" onClick={onClose}>Keep my account</Button>
        </div>
      </form>
    </Dialog>
  )
}

export type ConfirmSpec = { title: string; body: string; action: string; cancel?: string; run: () => Promise<unknown> }

export function ConfirmDialog({ spec, onClose }: { spec: ConfirmSpec; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const go = async () => {
    setBusy(true)
    try {
      await spec.run()
      onClose()
    } catch (e) {
      setError(e)
      setBusy(false)
    }
  }
  return (
    <Dialog title={spec.title} role="alertdialog" onClose={onClose}>
      <p className={s.body}>{spec.body}</p>
      {error != null && <Notice tone="error">{isApiError(error) ? error.message : 'Something went wrong. Try again.'}</Notice>}
      <div className={s.dialogActions}>
        <Button busy={busy} onClick={go}>{spec.action}</Button>
        <Button variant="quiet" onClick={onClose}>{spec.cancel ?? 'Cancel'}</Button>
      </div>
    </Dialog>
  )
}
