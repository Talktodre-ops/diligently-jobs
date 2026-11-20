import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router'
import { useUsage } from '../../app/UsageCard'
import { isApiError } from '../../api/client'
import { FOLLOW_UP_DAYS, type LetterTone, type Profile, type Reminders, type User, type Writing } from '../../api/types'
import { meKey, useMe, useProfile, useResetSession } from '../../auth/session'
import { useProviders } from '../auth/api'
import { inferPaper } from '../onboarding/cvFacts'
import { Button } from '../../ui/Button'
import { Icon } from '../../ui/Icon'
import { Notice } from '../../ui/Notice'
import { PageState } from '../../ui/PageState'
import { Switch } from '../../ui/Switch'
import { TopBar } from '../../ui/TopBar'
import {
  downloadExport, GOOGLE_LINK_URL, useDisconnectGoogle, useRevokeOthers, useRevokeSession, useSaveSetting, useSessions,
  useSetPasswordLink, useSignOut, type ProfilePatch, type SessionRow,
} from './api'
import { Choice, type ChoiceOption } from './Choice'
import {
  ChangeEmailDialog, ChangePasswordDialog, ConfirmDialog, DeleteAccountDialog, DeleteWithCodeDialog, PasswordLinkSentDialog, TimeZoneDialog,
  type ConfirmSpec,
} from './SettingsDialogs'
import { zoneLabel } from './timeZones'
import { useSectionSpy } from './useSectionSpy'
import s from './SettingsPage.module.css'

const SECTIONS = [
  { id: 'account', label: 'Account' },
  { id: 'reminders', label: 'Reminders' },
  { id: 'emails', label: 'Emails' },
  { id: 'documents', label: 'Your documents' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'plan', label: 'Plan' },
  { id: 'devices', label: 'Devices' },
  { id: 'privacy', label: 'Privacy and data' },
] as const
const SECTION_IDS = SECTIONS.map((x) => x.id)

const DAYS: ChoiceOption<Reminders['follow_up_days']>[] = FOLLOW_UP_DAYS.map((d) => ({ value: d, label: `${d} days` }))
const HOURS: ChoiceOption<Reminders['send_hour']>[] = [
  { value: 9, label: 'Morning', sub: '9:00' },
  { value: 13, label: 'Midday', sub: '13:00' },
  { value: 18, label: 'Evening', sub: '18:00' },
]
const PAPERS: ChoiceOption<Profile['paper_size']>[] = [{ value: 'a4', label: 'A4' }, { value: 'letter', label: 'US Letter' }]
const SPELLINGS: ChoiceOption<NonNullable<Writing['spelling']>>[] = [{ value: 'en-GB', label: 'British' }, { value: 'en-US', label: 'American' }]
const TONES: ChoiceOption<LetterTone>[] = [{ value: 'direct', label: 'Direct' }, { value: 'warm', label: 'Warm' }, { value: 'formal', label: 'Formal' }]
const THEMES: ChoiceOption<Profile['theme']>[] = [{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]
const EMAILS: { id: 'weekly_summary' | 'running_low' | 'product_news'; label: string; note: string }[] = [
  { id: 'weekly_summary', label: 'Monday summary', note: 'What needs you this week, and which applications have gone quiet' },
  { id: 'running_low', label: 'Running low', note: 'When you have 2 applications left this month' },
  { id: 'product_news', label: 'Product news', note: 'A few emails a year. Off unless you turn it on.' },
]

const GOOGLE_NOTICES: Record<string, { tone: 'success' | 'error'; text: string }> = {
  connected: { tone: 'success', text: 'Google is connected. You can sign in with it now.' },
  in_use: { tone: 'error', text: 'That Google account already belongs to another Diligently account. Pick a different Google account, or sign in with that one instead.' },
  error: { tone: 'error', text: 'Google did not connect. Try again.' },
}

/** "Edge on Windows" from a user-agent string; good enough to tell devices apart. */
export function deviceName(ua: string | null) {
  if (!ua) return 'Unknown device'
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser'
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : ''
  return os ? `${browser} on ${os}` : browser
}

/** The stored spelling, or what the server would infer from the location (the same rule as paper size). */
export function shownSpelling(p: Profile): NonNullable<Writing['spelling']> {
  return p.writing.spelling ?? (inferPaper(p.location) === 'letter' ? 'en-US' : 'en-GB')
}

const seen = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const longDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })

/** A setting with its label (and note) on the left and one control on the right. */
function Row({ label, note, children }: { label: string; note?: ReactNode; children?: ReactNode }) {
  return (
    <div className={s.row}>
      <span className={s.rowText}>
        <span className={s.rowLabel}>{label}</span>
        {note && <span className={s.rowNote}>{note}</span>}
      </span>
      {children && <span className={s.rowAction}>{children}</span>}
    </div>
  )
}

/** A labelled segmented choice with an optional hint under it. */
function Field({ id, label, hint, children }: { id: string; label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className={s.field}>
      <span id={id} className={s.rowLabel}>{label}</span>
      <div className={s.fieldBody}>
        {children}
        {hint && <div className={s.hint}>{hint}</div>}
      </div>
    </div>
  )
}

function Section({ id, title, intro, children }: { id: string; title: string; intro?: string; children: ReactNode }) {
  return (
    <section id={id} className={s.section} aria-labelledby={`h-${id}`}>
      <div className={s.sectionHead}>
        <h2 id={`h-${id}`} className={s.h}>{title}</h2>
        {intro && <p className={s.intro}>{intro}</p>}
      </div>
      {children}
    </section>
  )
}

function useSavedAnnouncer() {
  const [text, setText] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const announce = (next: string) => {
    clearTimeout(timer.current)
    // Clearing first makes a second "Saved" in a row count as a change for screen readers.
    setText('')
    timer.current = setTimeout(() => {
      setText(next)
      timer.current = setTimeout(() => setText(''), 4000)
    }, 60)
  }
  return [text, announce] as const
}

export default function SettingsPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const me = useMe()
  const profile = useProfile()
  const usage = useUsage()
  const sessions = useSessions()
  const providers = useProviders()
  const save = useSaveSetting()
  const revoke = useRevokeSession()
  const revokeOthers = useRevokeOthers()
  const signOut = useSignOut()
  const passwordLink = useSetPasswordLink()
  const disconnect = useDisconnectGoogle()
  const reset = useResetSession()
  const [dialog, setDialog] = useState<'email' | 'password' | 'delete' | 'zone' | 'password-sent' | null>(null)
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportMsg, setExportMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [accountError, setAccountError] = useState<string | null>(null)
  const [google] = useState(() => params.get('google'))
  const [savedText, announce] = useSavedAnnouncer()
  const ready = !!profile.data && !!me.data
  const [active, setActive] = useSectionSpy(SECTION_IDS, ready)

  // Back from Google in link mode: show what happened once, then tidy the address.
  const googleParam = params.get('google')
  useEffect(() => {
    if (!googleParam) return
    if (googleParam === 'connected') void qc.invalidateQueries({ queryKey: meKey })
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      next.delete('google')
      return next
    }, { replace: true })
  }, [googleParam, qc, setParams])

  if (profile.isPending || me.isPending) return <PageState.Loading />
  if (profile.isError) return <PageState.Error error={profile.error} onRetry={() => profile.refetch()} />
  if (me.isError) return <PageState.Error error={me.error} onRetry={() => me.refetch()} />
  if (!me.data) return <PageState.Loading />
  const p = profile.data
  const user: User = me.data
  const others = (sessions.data ?? []).filter((x) => !x.current)

  const change = (patch: ProfilePatch) => {
    setSaveError(null)
    save.mutate(patch, {
      onSuccess: () => announce('Saved'),
      onError: (e) => {
        announce('')
        setSaveError(`That did not save, so it is back as it was. ${isApiError(e) ? e.message : 'Try again.'}`)
      },
    })
  }

  const leave = async () => {
    await reset(null)
    navigate('/welcome', { replace: true })
  }
  const doSignOut = () => signOut.mutate(undefined, { onSettled: leave })
  const doExport = async () => {
    setExporting(true)
    setExportMsg(null)
    try {
      const name = await downloadExport()
      setExportMsg({ ok: true, text: `Downloaded ${name}.` })
    } catch (e) {
      setExportMsg({ ok: false, text: isApiError(e) ? e.message : 'Could not prepare your data. Try again.' })
    }
    setExporting(false)
  }
  const askRevoke = (row: SessionRow) =>
    setConfirm({
      title: 'Sign out this device?',
      body: `${deviceName(row.user_agent)} will be signed out and needs to sign in again.`,
      action: 'Sign it out',
      run: () => revoke.mutateAsync(row.id),
    })
  const askRevokeOthers = () =>
    setConfirm({
      title: 'Sign out every other device?',
      body: `This signs out ${others.length} other device${others.length === 1 ? '' : 's'}. This one stays signed in.`,
      action: 'Sign them out',
      run: () => revokeOthers.mutateAsync(),
    })
  const askDisconnect = () =>
    setConfirm({
      title: 'Disconnect Google?',
      body: 'You will sign in with your email and password. You can connect Google again here at any time.',
      action: 'Disconnect',
      run: () => disconnect.mutateAsync(),
    })
  const sendPasswordLink = () => {
    setAccountError(null)
    passwordLink.mutate(undefined, {
      onSuccess: () => setDialog('password-sent'),
      onError: (e) => {
        if (isApiError(e, 'has_password')) void qc.invalidateQueries({ queryKey: meKey })
        setAccountError(isApiError(e) ? e.message : 'Could not send the link. Try again.')
      },
    })
  }

  const u = usage.data
  const pct = u?.monthly_limit ? Math.min(100, Math.round((u.applications_this_month / u.monthly_limit) * 100)) : 0
  const zone = p.reminders.time_zone
  const googleOn = providers.data?.google === true
  const googleNotice = google ? (Object.hasOwn(GOOGLE_NOTICES, google) ? GOOGLE_NOTICES[google] : GOOGLE_NOTICES.error) : null

  return (
    <>
      <div className={s.head}>
        <TopBar
          back="/profile"
          backLabel="Back to profile"
          title="Settings"
          end={<span className={s.saved} role="status" aria-live="polite">{savedText}</span>}
        />
        {saveError && (
          <div className={s.headNotice}>
            <Notice tone="error">
              {saveError}{' '}
              <button type="button" className={s.inlineBtn} onClick={() => setSaveError(null)}>Dismiss</button>
            </Notice>
          </div>
        )}
      </div>

      <div className={s.page}>
        <nav className={s.nav} aria-label="Settings sections">
          {SECTIONS.map((x) => (
            <a key={x.id} href={`#${x.id}`} className={s.navLink} aria-current={active === x.id ? 'true' : undefined} onClick={() => setActive(x.id)}>
              {x.label}
            </a>
          ))}
        </nav>

        <div className={s.content}>
          {googleNotice && <Notice tone={googleNotice.tone}>{googleNotice.text}</Notice>}

          <Section id="account" title="Account">
            <div className={s.card}>
              <Row label="Email" note={user.email}>
                <button type="button" className={s.action} onClick={() => setDialog('email')} aria-label="Change email">Change</button>
              </Row>
              {user.has_password ? (
                <Row label="Password" note={user.password_changed_at ? `Last changed ${longDate(user.password_changed_at)}` : 'Set'}>
                  <button type="button" className={s.action} onClick={() => setDialog('password')} aria-label="Change password">Change</button>
                </Row>
              ) : (
                <Row label="Password" note="None yet. You sign in with Google.">
                  <button type="button" className={s.action} onClick={sendPasswordLink} disabled={passwordLink.isPending}>
                    {passwordLink.isPending ? 'Sending' : 'Set a password'}
                  </button>
                </Row>
              )}
              {googleOn && (
                user.google_connected ? (
                  <Row label="Google" note={user.has_password ? 'Connected. You can sign in with Google or your password.' : 'Connected. You sign in with it.'}>
                    {user.has_password && <button type="button" className={`${s.action} ${s.plain}`} onClick={askDisconnect} aria-label="Disconnect Google">Disconnect</button>}
                  </Row>
                ) : (
                  <Row label="Google" note="Not connected">
                    <a className={s.action} href={GOOGLE_LINK_URL} aria-label="Connect Google">Connect</a>
                  </Row>
                )
              )}
            </div>
            {accountError && <Notice tone="error">{accountError}</Notice>}
          </Section>

          <Section id="reminders" title="Reminders" intro="After you apply, we remind you to follow up, with the message already drafted.">
            <div className={s.card}>
              <Row label="Follow-up reminders" note="An email with a follow-up already drafted">
                <Switch label="Follow-up reminders" checked={p.notifications.follow_ups} onChange={(v) => change({ notifications: { follow_ups: v } })} />
              </Row>
              <Field id="f-days" label="Follow up after" hint="Picked for you on the Send screen. You can still change it per job.">
                <Choice labelledBy="f-days" value={p.reminders.follow_up_days} options={DAYS} onPick={(v) => change({ reminders: { follow_up_days: v } })} />
              </Field>
              <Field
                id="f-hour"
                label="Send reminders"
                hint={(
                  <span className={s.zoneRow}>
                    <span>Time zone: {zone ? zoneLabel(zone) : 'not set yet, so UTC'}</span>
                    <button type="button" className={`${s.action} ${s.plain}`} onClick={() => setDialog('zone')} aria-label="Change time zone">Change</button>
                  </span>
                )}
              >
                <Choice labelledBy="f-hour" value={p.reminders.send_hour} options={HOURS} onPick={(v) => change({ reminders: { send_hour: v } })} />
              </Field>
              <Row label="Keep weekends quiet" note="A reminder due on Saturday or Sunday waits for Monday">
                <Switch label="Keep weekends quiet" checked={p.reminders.skip_weekends} onChange={(v) => change({ reminders: { skip_weekends: v } })} />
              </Row>
            </div>
          </Section>

          <Section id="emails" title="Emails we send you">
            <div className={s.card}>
              {EMAILS.map((t) => (
                <Row key={t.id} label={t.label} note={t.note}>
                  <Switch label={t.label} checked={p.notifications[t.id]} onChange={(v) => change({ notifications: { [t.id]: v } })} />
                </Row>
              ))}
              <div className={s.security}>
                <Icon name="lock" size={20} />
                <span>New sign-ins, password and email changes always reach you. They keep your account safe.</span>
              </div>
            </div>
          </Section>

          <Section id="documents" title="Your documents">
            <div className={s.card}>
              <Field id="f-paper" label="Paper size">
                <Choice labelledBy="f-paper" value={p.paper_size} options={PAPERS} onPick={(v) => change({ paper_size: v })} />
              </Field>
              <Field id="f-spelling" label="Spelling" hint="Organised or organized, CV or résumé. Used in every CV and letter we write.">
                <Choice labelledBy="f-spelling" value={shownSpelling(p)} options={SPELLINGS} onPick={(v) => change({ writing: { spelling: v } })} />
              </Field>
              <Field id="f-tone" label="Cover letters start" hint="The first draft's tone. Each letter can still switch.">
                <Choice labelledBy="f-tone" value={p.writing.letter_tone} options={TONES} onPick={(v) => change({ writing: { letter_tone: v } })} />
              </Field>
            </div>
          </Section>

          <Section id="appearance" title="Appearance">
            <div className={`${s.card} ${s.padded}`}>
              <Choice label="Appearance" value={p.theme} options={THEMES} onPick={(v) => change({ theme: v })} />
            </div>
          </Section>

          <div className={s.pair}>
            <Section id="plan" title="Plan">
              <div className={`${s.card} ${s.padded} ${s.stack}`}>
                {usage.isPending && <span className={s.muted}>Loading usage</span>}
                {usage.isError && <span className={s.muted}>Usage is not available right now.</span>}
                {u && (
                  <>
                    <div className={s.planRow}>
                      <strong className={s.plan}>{u.plan}</strong>
                      <span className={s.muted}>{u.monthly_limit ? `${u.applications_this_month} of ${u.monthly_limit} applications` : `${u.applications_this_month} applications, no limit`}</span>
                    </div>
                    {u.monthly_limit ? (
                      <div className={s.track} role="meter" aria-label="Applications used this month" aria-valuemin={0} aria-valuemax={u.monthly_limit} aria-valuenow={u.applications_this_month}>
                        <div className={s.fill} style={{ width: `${pct}%` }} />
                      </div>
                    ) : null}
                    <span className={s.hint}>Resets on {longDate(u.resets_on)}.</span>
                  </>
                )}
              </div>
            </Section>

            <Section id="devices" title="Signed-in devices">
              <div className={s.card}>
                {sessions.isPending && <div className={s.cardNote}><span className={s.muted}>Loading devices</span></div>}
                {sessions.isError && <div className={s.cardNote}><span className={s.muted}>Devices are not available right now.</span></div>}
                {sessions.data && (
                  <ul className={s.sessions}>
                    {sessions.data.map((row) => (
                      <li key={row.id} className={s.session}>
                        <span className={s.sessionText}>
                          <span className={s.rowLabel}>{deviceName(row.user_agent)}{row.current && <span className={s.badge}>This device</span>}</span>
                          <span className={s.rowNote}>{row.current ? 'Active now' : `Last active ${seen(row.last_seen_at)}`}{row.ip ? `, ${row.ip}` : ''}</span>
                        </span>
                        {!row.current && (
                          <button type="button" className={`${s.action} ${s.plain}`} onClick={() => askRevoke(row)} aria-label={`Sign out ${deviceName(row.user_agent)}, last active ${seen(row.last_seen_at)}`}>Sign out</button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {others.length > 0 && (
                  <div className={s.cardNote}><Button variant="quiet" small onClick={askRevokeOthers}>Sign out all other devices</Button></div>
                )}
              </div>
            </Section>
          </div>

          <Section id="privacy" title="Privacy and data">
            <div className={`${s.card} ${s.padded} ${s.stack}`}>
              <p className={s.privacy}>To write and score, your CV and the job you paste go to Anthropic&apos;s Claude. To research a company, its name goes to Tavily. Nothing is sold or used for ads.</p>
              <Button variant="quiet" className={s.exportBtn} busy={exporting} onClick={doExport}>{exporting ? 'Preparing your data' : 'Download my data'}</Button>
              <div role="status" aria-live="polite">
                {exportMsg && <p className={exportMsg.ok ? s.muted : s.err}>{exportMsg.text}</p>}
              </div>
            </div>
          </Section>

          <div className={s.leave}>
            <Button variant="quiet" className={s.signOut} busy={signOut.isPending} onClick={doSignOut}>Sign out</Button>
            <Button variant="ghost" className={s.deleteBtn} onClick={() => setDialog('delete')}>Delete account</Button>
          </div>
        </div>
      </div>

      {dialog === 'email' && <ChangeEmailDialog current={user.email} hasPassword={user.has_password} onClose={() => setDialog(null)} />}
      {dialog === 'password' && <ChangePasswordDialog onClose={() => setDialog(null)} />}
      {dialog === 'password-sent' && <PasswordLinkSentDialog email={user.email} onClose={() => setDialog(null)} />}
      {dialog === 'delete' && (user.has_password
        ? <DeleteAccountDialog onClose={() => setDialog(null)} onDeleted={leave} />
        : <DeleteWithCodeDialog email={user.email} onClose={() => setDialog(null)} onDeleted={leave} />)}
      {dialog === 'zone' && <TimeZoneDialog current={zone} onPick={(z) => change({ reminders: { time_zone: z } })} onClose={() => setDialog(null)} />}
      {confirm && <ConfirmDialog spec={confirm} onClose={() => setConfirm(null)} />}
    </>
  )
}
