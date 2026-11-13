import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useUsage } from '../../app/UsageCard'
import { isApiError } from '../../api/client'
import type { Profile } from '../../api/types'
import { useMe, useProfile, useResetSession } from '../../auth/session'
import { Button } from '../../ui/Button'
import { Notice } from '../../ui/Notice'
import { PageState } from '../../ui/PageState'
import { TopBar } from '../../ui/TopBar'
import {
  downloadExport, useRevokeOthers, useRevokeSession, useSessions, useSignOut, useUpdateProfile, type SessionRow,
} from './api'
import { ChangeEmailDialog, ChangePasswordDialog, ConfirmDialog, DeleteAccountDialog, type ConfirmSpec } from './SettingsDialogs'
import s from './SettingsPage.module.css'

const PAPERS: { id: Profile['paper_size']; label: string }[] = [{ id: 'a4', label: 'A4' }, { id: 'letter', label: 'US Letter' }]
const THEMES: { id: Profile['theme']; label: string }[] = [{ id: 'system', label: 'System' }, { id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }]
const TOGGLES: { id: keyof Profile['notifications']; label: string; note: string }[] = [
  { id: 'follow_ups', label: 'Follow-up reminders', note: 'A nudge with a draft ready' },
  { id: 'interview_prep', label: 'Interview prep', note: 'Talking points the day before' },
  { id: 'product_news', label: 'Product news', note: 'A few emails a year' },
]

/** "Edge on Windows" from a user-agent string; good enough to tell devices apart. */
export function deviceName(ua: string | null) {
  if (!ua) return 'Unknown device'
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser'
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : ''
  return os ? `${browser} on ${os}` : browser
}

const seen = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

function Segmented<T extends string>({ label, value, options, onPick }: { label: string; value: T; options: { id: T; label: string }[]; onPick: (v: T) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className={s.seg}>
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={value === o.id} className={s.segBtn} onClick={() => onPick(o.id)}>{o.label}</button>
      ))}
    </div>
  )
}

export default function SettingsPage() {
  const navigate = useNavigate()
  const me = useMe()
  const profile = useProfile()
  const usage = useUsage()
  const sessions = useSessions()
  const update = useUpdateProfile()
  const revoke = useRevokeSession()
  const revokeOthers = useRevokeOthers()
  const signOut = useSignOut()
  const reset = useResetSession()
  const [dialog, setDialog] = useState<'email' | 'password' | 'delete' | null>(null)
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportMsg, setExportMsg] = useState<{ ok: boolean; text: string } | null>(null)

  if (profile.isPending || me.isPending) return <PageState.Loading />
  if (profile.isError) return <PageState.Error error={profile.error} onRetry={() => profile.refetch()} />
  const p = profile.data
  const others = (sessions.data ?? []).filter((x) => !x.current)

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
      body: `${deviceName(row.user_agent)} will be signed out and needs your password to get back in.`,
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

  const u = usage.data
  const pct = u?.monthly_limit ? Math.min(100, Math.round((u.applications_this_month / u.monthly_limit) * 100)) : 0

  return (
    <>
      <TopBar back="/profile" backLabel="Back to profile" title="Settings" />
      <main className={s.main}>
        {update.isError && <Notice tone="error">{isApiError(update.error) ? update.error.message : 'Could not save that. Try again.'}</Notice>}

        <section className={s.section} aria-labelledby="h-plan">
          <h2 id="h-plan" className={s.h}>Plan and usage</h2>
          <div className={s.card}>
            {usage.isPending && <span className={s.muted}>Loading usage</span>}
            {usage.isError && <span className={s.muted}>Usage is not available right now.</span>}
            {u && (
              <>
                <div className={s.rowBetween}><strong className={s.plan}>{u.plan}</strong><span className={s.muted}>plan</span></div>
                <div className={s.rowBetween}>
                  <span>Applications this month</span>
                  <span>{u.monthly_limit ? `${u.applications_this_month} of ${u.monthly_limit}` : `${u.applications_this_month}, no limit`}</span>
                </div>
                {u.monthly_limit ? (
                  <div className={s.track} role="meter" aria-label="Applications used this month" aria-valuemin={0} aria-valuemax={u.monthly_limit} aria-valuenow={u.applications_this_month}>
                    <div className={s.fill} style={{ width: `${pct}%` }} />
                  </div>
                ) : null}
                <div className={s.muted}>Resets on {new Date(u.resets_on).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}.</div>
              </>
            )}
          </div>
        </section>

        <section className={s.section} aria-labelledby="h-docs">
          <h2 id="h-docs" className={s.h}>Documents</h2>
          <div className={s.card}>
            <div className={s.label}>Paper size</div>
            <Segmented label="Paper size" value={p.paper_size} options={PAPERS} onPick={(v) => v !== p.paper_size && update.mutate({ paper_size: v })} />
            <div className={s.label}>Appearance</div>
            <Segmented label="Appearance" value={p.theme} options={THEMES} onPick={(v) => v !== p.theme && update.mutate({ theme: v })} />
          </div>
        </section>

        <section className={s.section} aria-labelledby="h-notes">
          <h2 id="h-notes" className={s.h}>Notifications</h2>
          <div className={s.card}>
            {TOGGLES.map((t) => (
              <div key={t.id} className={s.toggleRow}>
                <span className={s.toggleText}><span className={s.toggleLabel}>{t.label}</span><span className={s.muted}>{t.note}</span></span>
                <button
                  type="button" role="switch" aria-checked={p.notifications[t.id]} aria-label={t.label}
                  className={s.switch} onClick={() => update.mutate({ notifications: { [t.id]: !p.notifications[t.id] } })}
                ><span className={s.knob} /></button>
              </div>
            ))}
          </div>
        </section>

        <section className={s.section} aria-labelledby="h-account">
          <h2 id="h-account" className={s.h}>Account</h2>
          <div className={s.card}>
            <button type="button" className={s.linkRow} onClick={() => setDialog('email')}><span>Email</span><span className={s.muted}>{me.data?.email}</span></button>
            <button type="button" className={s.linkRow} onClick={() => setDialog('password')}><span>Password</span><span className={s.muted}>Change</span></button>
            <button type="button" className={s.linkRow} onClick={doExport} disabled={exporting}><span>Download my data</span><span className={s.muted}>{exporting ? 'Preparing' : 'JSON'}</span></button>
          </div>
          <div role="status" aria-live="polite">
            {exportMsg && <p className={exportMsg.ok ? s.muted : s.err}>{exportMsg.text}</p>}
          </div>
        </section>

        <section className={s.section} aria-labelledby="h-devices">
          <h2 id="h-devices" className={s.h}>Devices</h2>
          <div className={s.card}>
            {sessions.isPending && <span className={s.muted}>Loading devices</span>}
            {sessions.isError && <span className={s.muted}>Devices are not available right now.</span>}
            {sessions.data && (
              <ul className={s.sessions}>
                {sessions.data.map((row) => (
                  <li key={row.id} className={s.session}>
                    <div className={s.sessionText}>
                      <div className={s.toggleLabel}>{deviceName(row.user_agent)}{row.current && <span className={s.badge}>This device</span>}</div>
                      <div className={s.muted}>Last active {seen(row.last_seen_at)}{row.ip ? `, ${row.ip}` : ''}</div>
                    </div>
                    {!row.current && <Button variant="quiet" small onClick={() => askRevoke(row)} aria-label={`Sign out ${deviceName(row.user_agent)}, last active ${seen(row.last_seen_at)}`}>Sign out</Button>}
                  </li>
                ))}
              </ul>
            )}
            {others.length > 0 && <Button variant="secondary" small onClick={askRevokeOthers}>Sign out all other devices</Button>}
          </div>
        </section>

        <section className={s.section}>
          <Button variant="quiet" block busy={signOut.isPending} onClick={doSignOut}>Sign out</Button>
          <Button variant="ghost" block className={s.deleteBtn} onClick={() => setDialog('delete')}>Delete account</Button>
        </section>
      </main>

      {dialog === 'email' && <ChangeEmailDialog current={me.data?.email ?? ''} onClose={() => setDialog(null)} />}
      {dialog === 'password' && <ChangePasswordDialog onClose={() => setDialog(null)} />}
      {dialog === 'delete' && <DeleteAccountDialog onClose={() => setDialog(null)} onDeleted={leave} />}
      {confirm && <ConfirmDialog spec={confirm} onClose={() => setConfirm(null)} />}
    </>
  )
}
