import { useMemo, useState, type FormEvent } from 'react'
import { isApiError } from '../../api/client'
import { browserTimeZone } from '../../auth/timeZone'
import { Button } from '../../ui/Button'
import { Notice } from '../../ui/Notice'
import { TextField } from '../../ui/TextField'
import { deleteAccount, useChangeEmail, useChangePassword, useSendDeleteCode } from './api'
import { Dialog } from '../../ui/Dialog'
import { searchZones, zoneCity, zoneLabel, zoneOffset, zoneRegion } from './timeZones'
import s from './SettingsPage.module.css'

const fieldMsg = (e: unknown, f: string) => (isApiError(e) && e.field === f ? e.message : null)
const otherMsg = (e: unknown, fields: string[]) =>
  e && !(isApiError(e) && e.field && fields.includes(e.field)) ? (isApiError(e) ? e.message : 'Something went wrong. Try again.') : null

export function ChangeEmailDialog({ current, hasPassword = true, onClose }: { current: string; hasPassword?: boolean; onClose: () => void }) {
  const change = useChangeEmail()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const submit = (e: FormEvent) => { e.preventDefault(); change.mutate({ new_email: email.trim(), password }) }
  if (!hasPassword) {
    return (
      <Dialog title="Set a password first" onClose={onClose}>
        <p className={s.body}>Changing your email asks for your password, and this account does not have one yet. Use Set a password on the Password row, then come back here.</p>
        <Button onClick={onClose}>Got it</Button>
      </Dialog>
    )
  }
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
      await deleteAccount({ password })
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

export function PasswordLinkSentDialog({ email, onClose }: { email: string; onClose: () => void }) {
  return (
    <Dialog title="Check your inbox" onClose={onClose}>
      <p className={s.body} role="status">We sent a link to {email}. Open it to set your password. After that you can sign in with Google or your password.</p>
      <Button onClick={onClose}>Done</Button>
    </Dialog>
  )
}

const CODE_LENGTH = 6

/**
 * Delete for an account with no password (Google only): we email a 6-digit
 * code and the person types it here instead.
 */
export function DeleteWithCodeDialog({ email, onClose, onDeleted }: { email: string; onClose: () => void; onDeleted: () => void }) {
  const send = useSendDeleteCode()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [short, setShort] = useState(false)
  const sent = send.isSuccess

  const sendCode = () => {
    setError(null)
    setCode('')
    send.mutate()
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (code.length !== CODE_LENGTH) { setShort(true); return }
    setBusy(true)
    setError(null)
    try {
      await deleteAccount({ code })
      onDeleted()
    } catch (err) {
      setError(err)
      setBusy(false)
    }
  }

  const expired = isApiError(error, 'code_expired')
  const codeError = short ? 'Enter all 6 digits from the email.'
    : expired ? 'That code has expired. Send a new one.'
      : fieldMsg(error, 'code')
  const other = expired ? null : otherMsg(error, ['code'])
  const sendError = send.isError ? (isApiError(send.error) ? send.error.message : 'Could not send the code. Try again.') : null

  return (
    <Dialog title="Delete your account?" role="alertdialog" onClose={onClose}>
      <p className={s.body}>Your CV, every application, letter and file go for good. This cannot be undone. Download your data first if you want a copy.</p>
      {!sent ? (
        <>
          <div className={s.codeNote}>You sign in with Google, so there is no password to check. We email a 6-digit code to <strong>{email}</strong> instead.</div>
          {sendError && <Notice tone="error">{sendError}</Notice>}
          <div className={s.dialogActions}>
            <Button busy={send.isPending} onClick={sendCode}>Email me a code</Button>
            <Button variant="ghost" onClick={onClose}>Keep my account</Button>
          </div>
        </>
      ) : (
        <form className={s.dialogForm} onSubmit={submit} noValidate>
          <div className={s.codeNote} role="status">You sign in with Google, so there is no password to check. We sent a 6-digit code to <strong>{email}</strong> instead.</div>
          <TextField
            label="Code from the email"
            className={s.codeField}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={CODE_LENGTH}
            placeholder="000000"
            autoFocus
            value={code}
            onChange={(e) => { setShort(false); setCode(e.target.value.replace(/\D/g, '').slice(0, CODE_LENGTH)) }}
            error={codeError}
            hint="It works for 30 minutes."
          />
          <div className={s.resend}>
            <Button variant="ghost" small busy={send.isPending} onClick={sendCode}>Send a new code</Button>
          </div>
          {sendError && <Notice tone="error">{sendError}</Notice>}
          {other && <Notice tone="error">{other}</Notice>}
          <div className={s.dialogActions}>
            <Button type="submit" busy={busy} className={s.danger}>Delete my account</Button>
            <Button variant="ghost" onClick={onClose}>Keep my account</Button>
          </div>
        </form>
      )}
    </Dialog>
  )
}

const MAX_ZONES = 50

/** Search every time zone the browser knows and pick one. */
export function TimeZoneDialog({ current, onPick, onClose }: { current: string | null; onPick: (zone: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const device = browserTimeZone()
  const results = useMemo(() => searchZones(query), [query])
  const shown = results.slice(0, MAX_ZONES)
  const pick = (zone: string) => {
    if (zone !== current) onPick(zone)
    onClose()
  }
  return (
    <Dialog title="Your time zone" onClose={onClose}>
      <p className={s.body}>Reminders and the Monday summary arrive at the hour you picked, in this time zone.</p>
      <TextField label="Search for a city" type="search" autoComplete="off" value={query} onChange={(e) => setQuery(e.target.value)} hint="For example Lagos, London or New York." />
      {device && device !== current && !query && (
        <Button variant="quiet" onClick={() => pick(device)}>Use this device: {zoneLabel(device)}</Button>
      )}
      <p className="visually-hidden" role="status" aria-live="polite">
        {results.length === 0 ? 'No time zones match.' : `${results.length} time zone${results.length === 1 ? '' : 's'} match.`}
      </p>
      {results.length === 0 ? (
        <p className={s.body}>Nothing matches {query.trim()}. Try the nearest large city.</p>
      ) : (
        <ul className={s.zoneList} aria-label="Time zones">
          {shown.map((z) => (
            <li key={z}>
              <button type="button" className={s.zoneBtn} aria-current={z === current ? 'true' : undefined} onClick={() => pick(z)}>
                <span className={s.zoneCity}>{zoneCity(z)}{z === current && <span className={s.badge}>Current</span>}</span>
                <span className={s.muted}>{[zoneRegion(z), zoneOffset(z)].filter(Boolean).join(', ')}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {results.length > shown.length && <p className={s.muted}>Showing {MAX_ZONES} of {results.length}. Type more of the name to narrow it down.</p>}
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
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
