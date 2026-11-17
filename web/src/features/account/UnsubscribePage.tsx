import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { isApiError } from '../../api/client'
import { Button } from '../../ui/Button'
import { LogoMark } from '../../ui/LogoMark'
import { Notice } from '../../ui/Notice'
import { isEmailKind, resubscribe, unsubscribe, type EmailKind } from './api'
import s from './UnsubscribePage.module.css'

const COPY: Record<EmailKind, { off: string; on: string; onBody: string; others: string }> = {
  follow_ups: {
    off: 'No more follow-up reminders.',
    on: 'Follow-up reminders are back on.',
    onBody: 'The next one arrives when an application is due a follow-up.',
    others: 'Your Monday summary and everything else stay as they were.',
  },
  weekly_summary: {
    off: 'No more Monday summaries.',
    on: 'Monday summaries are back on.',
    onBody: 'The next one arrives on Monday morning.',
    others: 'Follow-up reminders and everything else stay as they were.',
  },
  running_low: {
    off: 'No more running low emails.',
    on: 'Running low emails are back on.',
    onBody: 'We will tell you when you have 2 applications left in a month.',
    others: 'Follow-up reminders and everything else stay as they were.',
  },
  product_news: {
    off: 'No more product news.',
    on: 'Product news is back on.',
    onBody: 'A few emails a year, when there is something worth telling you.',
    others: 'Follow-up reminders and everything else stay as they were.',
  },
}

type Phase =
  | { name: 'working' }
  | { name: 'off'; email: string }
  | { name: 'on'; email: string }
  | { name: 'bad_link' }
  | { name: 'not_found' }
  | { name: 'failed'; message: string }

const failure = (e: unknown): Phase =>
  isApiError(e) && (e.status === 404 || e.code === 'not_found') ? { name: 'not_found' }
    : isApiError(e) && e.status === 400 ? { name: 'bad_link' }
      : { name: 'failed', message: isApiError(e) ? e.message : 'Something went wrong. Try again.' }

/**
 * The unsubscribe link in an optional email lands here. No sign-in: the token
 * in the link only switches email preferences. It turns the email off on load
 * and offers Undo.
 */
export default function UnsubscribePage() {
  const [params] = useSearchParams()
  const token = params.get('token')?.trim() ?? ''
  const rawKind = params.get('kind')
  const kind = isEmailKind(rawKind) ? rawKind : null
  const valid = !!token && !!kind
  const [phase, setPhase] = useState<Phase>({ name: 'working' })
  const [undoing, setUndoing] = useState(false)
  const [undoError, setUndoError] = useState<string | null>(null)
  const started = useRef(false)

  const turnOff = (t: string, k: EmailKind) =>
    unsubscribe({ token: t, kind: k })
      .then((r) => setPhase({ name: 'off', email: r.email }))
      .catch((e: unknown) => setPhase(failure(e)))

  useEffect(() => {
    if (!token || !kind || started.current) return
    started.current = true
    void turnOff(token, kind)
  }, [token, kind])

  const undo = async () => {
    if (!kind) return
    setUndoing(true)
    setUndoError(null)
    try {
      const r = await resubscribe({ token, kind })
      setPhase({ name: 'on', email: r.email })
    } catch (e) {
      setUndoError(isApiError(e) ? e.message : 'That did not work. Try again.')
    }
    setUndoing(false)
  }
  const retry = () => {
    if (!kind) return
    setPhase({ name: 'working' })
    void turnOff(token, kind)
  }

  const shown: Phase = valid ? phase : { name: 'bad_link' }
  const copy = kind ? COPY[kind] : null

  return (
    <div className={s.page}>
      <div className={s.brand} aria-hidden="true"><LogoMark />diligently<span>.</span></div>
      <main className={s.main} aria-busy={shown.name === 'working' || undefined}>
        {shown.name === 'working' && (
          <p className={s.body} role="status">Turning that email off.</p>
        )}
        {shown.name === 'off' && copy && (
          <>
            <h1 className={s.title}>{copy.off}</h1>
            <p className={s.body}>Done for {shown.email}. {copy.others}</p>
            {undoError && <Notice tone="error">{undoError}</Notice>}
            <Button variant="quiet" className={s.undo} busy={undoing} onClick={undo}>Undo</Button>
          </>
        )}
        {shown.name === 'on' && copy && (
          <>
            <h1 className={s.title}>{copy.on}</h1>
            <p className={s.body} role="status">{copy.onBody}</p>
          </>
        )}
        {shown.name === 'bad_link' && (
          <>
            <h1 className={s.title}>This link is not complete.</h1>
            <p className={s.body}>Part of it is missing or changed. Open it again from the email, or change your emails in Settings.</p>
          </>
        )}
        {shown.name === 'not_found' && (
          <>
            <h1 className={s.title}>We do not recognise this link.</h1>
            <p className={s.body}>It may be from an account that no longer exists. If you still get emails from us, change them in Settings.</p>
          </>
        )}
        {shown.name === 'failed' && (
          <>
            <h1 className={s.title}>That did not go through.</h1>
            <Notice tone="error">{shown.message}</Notice>
            <Button variant="quiet" className={s.undo} onClick={retry}>Try again</Button>
          </>
        )}
      </main>
      <p className={s.foot}>No sign-in needed for this page. To change other emails, <Link to="/settings">open Settings</Link>.</p>
    </div>
  )
}
