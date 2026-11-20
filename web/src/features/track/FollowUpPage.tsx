import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router'
import { isApiError } from '../../api/client'
import { Button, ButtonLink } from '../../ui/Button'
import { Icon } from '../../ui/Icon'
import { Notice } from '../../ui/Notice'
import { PageState } from '../../ui/PageState'
import { TextArea } from '../../ui/TextField'
import { TopBar } from '../../ui/TopBar'
import {
  ago, useApplication, useDraftFollowUp, useFollowUps, useReminderAction, type Channel,
} from './api'
import s from './FollowUpPage.module.css'

const CHANNELS: { id: Channel; label: string; name: string }[] = [
  { id: 'email', label: 'Email', name: 'email' },
  { id: 'linkedin', label: 'LinkedIn', name: 'LinkedIn' },
]
const LINKEDIN_LIMIT = 300
const SNOOZE_DAYS = 3

function countLine(channel: Channel, text: string) {
  if (channel === 'linkedin') return `${text.length} of ${LINKEDIN_LIMIT} characters`
  const words = text.trim() ? text.trim().split(/\s+/).length : 0
  return `${words} words`
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  throw new Error('no clipboard')
}

const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' })

export default function FollowUpPage() {
  const { id = '' } = useParams()
  const app = useApplication(id)
  const fu = useFollowUps(id)
  const draft = useDraftFollowUp(id)
  const { snooze, done } = useReminderAction(id)
  const [channel, setChannel] = useState<Channel>('email')
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const [markedDone, setMarkedDone] = useState(false)
  const asked = useRef(new Set<Channel>())

  const current = fu.data?.drafts[channel] ?? null
  const reminder = fu.data?.reminder ?? null

  // First visit to a channel with no saved draft writes one. Asked once per
  // channel so a failure shows a retry button instead of looping.
  useEffect(() => {
    if (!fu.data || current || asked.current.has(channel)) return
    asked.current.add(channel)
    draft.mutate(channel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fu.data, current, channel])

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 2400)
    return () => clearTimeout(t)
  }, [copied])

  if (app.isPending || fu.isPending) return <PageState.Loading />
  if (app.isError || fu.isError) {
    return <PageState.Error error={app.error ?? fu.error} onRetry={() => { void app.refetch(); void fu.refetch() }} />
  }

  const company = app.data.company || 'this company'
  const name = CHANNELS.find((c) => c.id === channel)!.name
  const body = current ? (edits[current.id] ?? current.body) : ''
  const hasPlaceholder = /\{name\}/i.test(body)
  const isDone = markedDone || reminder?.status === 'done'

  const copy = async () => {
    try {
      await copyText(body)
      setCopyFailed(false)
      setCopied(true)
    } catch {
      setCopied(false)
      setCopyFailed(true)
    }
  }
  const openChannel = async () => {
    await copy()
    if (channel === 'email') {
      const subject = current?.subject ? `subject=${encodeURIComponent(current.subject)}&` : ''
      window.location.href = `mailto:?${subject}body=${encodeURIComponent(body)}`
    } else {
      window.open('https://www.linkedin.com/messaging/', '_blank', 'noopener')
    }
  }
  const markDone = () => {
    if (reminder) done.mutate(reminder.id, { onSuccess: () => setMarkedDone(true) })
    else setMarkedDone(true)
  }
  const mutationError = [draft.error, snooze.error, done.error].find(Boolean)

  if (isDone) {
    return (
      <>
        <TopBar back="/jobs" backLabel="Back to jobs" eyebrow={company} title="Follow up" />
        <main className={s.centered}>
          <div className={s.tick} aria-hidden="true"><Icon name="check" size={34} strokeWidth={2} /></div>
          <h2 className={s.h}>Followed up</h2>
          <p className={s.lede}>If you hear nothing in another week, we will suggest closing it out so it stops taking up space.</p>
          <ButtonLink to="/jobs" variant="dark">Back to jobs</ButtonLink>
        </main>
      </>
    )
  }

  const snoozed = reminder?.status === 'scheduled'

  return (
    <>
      <TopBar back="/jobs" backLabel="Back to jobs" eyebrow={company} title="Follow up" />
      <main className={s.main}>
        <div>
          <h2 className={s.h}>
            {app.data.submitted_at ? `Sent ${ago(app.data.submitted_at)}` : 'Time for a nudge'}
          </h2>
          <p className={s.lede}>A short, specific nudge works best. Here is one to start from.</p>
        </div>

        <div role="tablist" aria-label="Where to send it" className={s.tabs}>
          {CHANNELS.map((c) => (
            <button key={c.id} type="button" role="tab" aria-selected={channel === c.id} className={s.tab} onClick={() => setChannel(c.id)}>
              {c.label}
            </button>
          ))}
        </div>

        {mutationError != null && (
          <Notice tone="error">{isApiError(mutationError) ? mutationError.message : 'Something went wrong. Try again.'}</Notice>
        )}

        {!current && draft.isPending && (
          <div className={s.writing} role="status"><span className={s.dot} aria-hidden="true" />Writing your {name} draft</div>
        )}
        {!current && !draft.isPending && (
          <Button variant="secondary" onClick={() => draft.mutate(channel)}>Write a {name} draft</Button>
        )}

        {current && (
          <>
            {channel === 'email' && current.subject && (
              <div className={s.subject}>
                <div className={s.subjectLabel}>Subject</div>
                <div>{current.subject}</div>
              </div>
            )}
            <div>
              <TextArea
                label="Message"
                rows={channel === 'email' ? 10 : 6}
                value={body}
                onChange={(e) => setEdits((p) => ({ ...p, [current.id]: e.target.value }))}
                hint={hasPlaceholder ? 'Replace {name} with the name of the person you are writing to.' : undefined}
              />
              <div className={[s.count, channel === 'linkedin' && body.length > LINKEDIN_LIMIT && s.over].filter(Boolean).join(' ')}>
                {countLine(channel, body)}
                {channel === 'linkedin' && body.length > LINKEDIN_LIMIT ? `, trim ${body.length - LINKEDIN_LIMIT} to fit` : ''}
              </div>
            </div>
            <div className={s.row}>
              <Button variant="ghost" small busy={draft.isPending} onClick={() => draft.mutate(channel)}>
                <Icon name="refresh" size={16} />Write a new draft
              </Button>
            </div>
          </>
        )}

        {reminder && reminder.status !== 'done' && (
          <div className={s.snooze}>
            <Button variant="quiet" small busy={snooze.isPending} onClick={() => snooze.mutate({ reminderId: reminder.id, days: SNOOZE_DAYS })}>
              {`Not now, remind me in ${SNOOZE_DAYS} days`}
            </Button>
            <span role="status" className={s.note}>
              {snoozed ? `Reminder set for ${when(reminder.due_at)}.` : reminder.status === 'sent' ? 'Your reminder email has gone out.' : ''}
            </span>
          </div>
        )}
      </main>

      <div className={s.status} role="status" aria-live="polite">
        {copied && <div className={s.toast}>Copied. Paste it in {name}.</div>}
        {copyFailed && <div className={s.toast}>Could not copy. Select the text and copy it yourself.</div>}
      </div>
      <footer className={s.footer}>
        <div className={s.pair}>
          <Button variant="dark" disabled={!current} onClick={copy}><Icon name="copy" size={18} />Copy</Button>
          <Button variant="quiet" disabled={!current} onClick={openChannel}>Open {name}</Button>
        </div>
        <Button variant="primary" block busy={done.isPending} onClick={markDone}>I sent it, mark as followed up</Button>
      </footer>
    </>
  )
}
