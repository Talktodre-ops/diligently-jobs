import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Link, useLocation, useParams, useSearchParams } from 'react-router'
import { isApiError } from '../../api/client'
import { Button } from '../../ui/Button'
import { Icon } from '../../ui/Icon'
import { PageState } from '../../ui/PageState'
import { TopBar } from '../../ui/TopBar'
import { DESKTOP, useMediaQuery } from '../../ui/useMediaQuery'
import { CompanyPanel } from '../documents/CompanyPanel'
import { LetterPanel } from '../documents/LetterPanel'
import { SendSheet } from '../documents/SendSheet'
import { companyName, useBrief, usePipelineJob, useRewrites, type Brief, type Step } from './api'
import { ChangeSheet } from './ChangeSheet'
import { ChangesList } from './ChangesList'
import { CvTab } from './CvTab'
import { plural } from './format'
import { Progress } from './Progress'
import { LegacyApplication } from './LegacyApplication'
import { Questions } from './Questions'
import { reviewItems } from './reviewItems'
import { ScoreStrip } from './ScoreStrip'
import s from './ApplicationPage.module.css'

const TABS = [
  { id: 'cv', label: 'CV' },
  { id: 'letter', label: 'Letter' },
  { id: 'company', label: 'Company' },
] as const
type Tab = (typeof TABS)[number]['id']

/**
 * One application on one screen. Tailoring shows in place while it runs; the
 * CV, the letter and the company research are tabs; a suggestion opens in a
 * sheet over the CV; Send is a sheet too. The address carries the tab
 * (`?tab=`), an open suggestion (`?change=`, or `next` for the first one not
 * looked at) and Send (`?send=1`), so every state can be linked to.
 */
export default function ApplicationPage() {
  const { id = '' } = useParams()
  const location = useLocation()
  const [params, setParams] = useSearchParams()
  const qc = useQueryClient()
  const brief = useBrief(id)
  const desktop = useMediaQuery(DESKTOP)
  const [retriedJob, setRetriedJob] = useState<string | null>(null)

  const passedJob = (location.state as { jobId?: string } | null)?.jobId
  const briefStatus = brief.data?.pipeline?.status
  const jobId = retriedJob ?? brief.data?.pipeline?.job_id ?? passedJob ?? null
  // A finished job has nothing left to watch.
  const job = usePipelineJob(briefStatus === 'done' && !retriedJob ? null : jobId)
  const steps: Step[] = job.data?.progress ?? brief.data?.pipeline?.progress ?? []
  const status = job.data?.status ?? briefStatus
  const watchedDone = job.data ? job.data.progress?.filter((x) => x.status === 'done').length ?? 0 : 0
  const watchedStatus = job.data?.status

  // The brief learns the company after the first step and everything else at
  // the end; refresh as steps finish, and refresh it all when the run ends.
  useEffect(() => {
    if (watchedDone > 0) qc.invalidateQueries({ queryKey: ['application', id, 'brief'] })
    if (watchedStatus === 'done' || watchedStatus === 'failed') qc.invalidateQueries({ queryKey: ['application', id] })
  }, [watchedDone, watchedStatus, id, qc])

  const running = status === 'queued' || status === 'running'
  const failed = status === 'failed'
  const rewrites = useRewrites(id, !running && brief.isSuccess && !brief.data.application.legacy)
  const items = rewrites.data ? reviewItems(rewrites.data) : []

  const tabParam = params.get('tab')
  const tab: Tab = tabParam === 'letter' || tabParam === 'company' ? tabParam : 'cv'
  const sending = params.get('send') === '1'
  const changeParam = params.get('change')

  const update = (edit: (p: URLSearchParams) => void) =>
    setParams((p) => { const n = new URLSearchParams(p); edit(n); return n }, { replace: true })
  const setTab = (t: Tab) => update((n) => { if (t === 'cv') n.delete('tab'); else n.set('tab', t) })
  const openChange = (itemId: string, edit = false) => update((n) => {
    n.delete('send')
    n.set('change', itemId)
    if (edit) n.set('edit', '1'); else n.delete('edit')
  })
  const closeChange = () => update((n) => { n.delete('change'); n.delete('edit') })
  const openSend = () => update((n) => { n.delete('change'); n.delete('edit'); n.set('send', '1') })
  const closeSend = () => update((n) => n.delete('send'))

  if (brief.isPending) return <PageState.Loading />
  if (brief.isError) {
    if (isApiError(brief.error, 'not_found')) {
      return <PageState.Empty title="Application not found" body="It may have been deleted." action={<Link to="/">Go home</Link>} />
    }
    return <PageState.Error error={brief.error} onRetry={() => brief.refetch()} />
  }

  const b = brief.data
  if (b.application.legacy) return <LegacyApplication brief={b} desktop={desktop} />
  const company = companyName(b.application.company)
  const role = b.application.role ?? 'New application'
  const linkFailed = failed && !!b.application.source_url && steps.some((x) => x.key === 'read_job' && x.status === 'failed')

  const progress = status === 'queued' || status === 'running' || status === 'failed' ? (
    <Progress
      id={id}
      steps={steps}
      status={status}
      linkFailed={linkFailed}
      onRetried={setRetriedJob}
      onAlreadyRetried={() => brief.refetch()}
    />
  ) : null

  const startId = changeParam === 'next'
    ? (items.find((i) => i.status === 'pending') ?? items[0])?.id
    : items.find((i) => i.id === changeParam)?.id
  const sheet = changeParam && startId ? (
    <ChangeSheet key={startId} appId={id} items={items} startId={startId} startEditing={params.get('edit') === '1'} onClose={closeChange} />
  ) : sending ? (
    <SendSheet
      id={id}
      onClose={closeSend}
      onReview={() => openChange('next')}
      onWriteLetter={() => update((n) => { n.delete('send'); n.set('tab', 'letter') })}
    />
  ) : null

  const panels: Record<Tab, ReactNode> = {
    cv: running ? <Tailoring /> : (
      <div className={s.cvTab}>
        {!desktop && <Questions appId={id} />}
        <CvTab id={id} onOpen={(itemId) => openChange(itemId)} />
      </div>
    ),
    letter: running
      ? <Waiting what="Your letter is written after the CV. It shows here when tailoring finishes." />
      : <LetterPanel id={id} company={company} />,
    company: running
      ? <Waiting what={`What we find about ${company} shows here when tailoring finishes.`} />
      : <CompanyPanel id={id} company={company} />,
  }
  const tabs = <Tabs tab={tab} onChange={setTab} panels={panels} />
  const sendButton = (
    <Button onClick={openSend} disabled={running} className={s.send}>
      <Icon name="send" size={18} strokeWidth={2} />
      Send
    </Button>
  )
  const note = <SendNote brief={b} running={running} onReview={() => openChange('next')} />

  // One tree for both widths: the header, the left column and the footer
  // change, while the tabs and the sheet keep their places, so a window or
  // tablet crossing the desktop width keeps the drawn page and an open sheet.
  const where = [company, b.application.location].filter(Boolean).join(' · ')
  const header = desktop ? (
    <header className={s.deskHead}>
      <div className={s.deskTitles}>
        <Link to="/jobs" className={s.crumb}>All jobs</Link>
        <h1 className={s.deskH1}>{role}</h1>
        <div className={s.deskWhere}>{where}</div>
      </div>
      {!running && <ScoreStrip score={b.score} />}
      <div className={s.deskSend}>
        {sendButton}
        {note}
      </div>
    </header>
  ) : (
    <TopBar back="/" backLabel="Back to home" eyebrow={company} title={role} />
  )
  const side = desktop ? (
    <aside className={s.deskLeft} aria-label="What to look at">
      {progress}
      {!running && <Questions appId={id} />}
      {!running && rewrites.isSuccess && <ChangesList appId={id} items={items} onEdit={(itemId) => openChange(itemId, true)} />}
    </aside>
  ) : (
    <div className={s.top}>
      {progress}
      {!running && <ScoreStrip score={b.score} />}
    </div>
  )

  return (
    <>
      <div className={desktop ? s.desk : s.page}>
        {header}
        <div className={desktop ? s.deskCols : s.body}>
          {side}
          <div className={desktop ? s.deskMain : s.main}>{tabs}</div>
        </div>
        {!desktop && (
          <footer className={s.footer}>
            {note}
            {sendButton}
          </footer>
        )}
      </div>
      {sheet}
    </>
  )
}

function Tabs({ tab, onChange, panels }: { tab: Tab; onChange: (t: Tab) => void; panels: Record<Tab, ReactNode> }) {
  const base = useId()
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]!
    onChange(next.id)
    document.getElementById(`${base}-tab-${next.id}`)?.focus()
  }
  return (
    <div className={s.tabsWrap}>
      <div role="tablist" aria-label="Application" className={s.tabs}>
        {TABS.map((t, i) => (
          <button
            key={t.id}
            id={`${base}-tab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            aria-controls={`${base}-panel`}
            tabIndex={tab === t.id ? 0 : -1}
            className={s.tab}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div id={`${base}-panel`} role="tabpanel" aria-labelledby={`${base}-tab-${tab}`} className={s.panel}>
        {panels[tab]}
      </div>
    </div>
  )
}

/** Beside Send: what will go out, and a way into what was not looked at. */
function SendNote({ brief, running, onReview }: { brief: Brief; running: boolean; onReview: () => void }) {
  if (running) return <p className={s.note}>Send opens when your CV is ready.</p>
  const { decided, pending } = brief.score
  if (decided === 0) return <p className={s.note}>Your CV goes out as you wrote it.</p>
  return (
    <p className={s.note}>
      {plural(decided, 'change')} in your CV
      {pending > 0 && (
        <>
          <br />
          <button type="button" className={s.noteLink} onClick={onReview}>{pending} not looked at yet</button>
        </>
      )}
    </p>
  )
}

function Tailoring() {
  return (
    <div className={s.skeleton} aria-label="Your CV, still being tailored">
      <div className={s.bar} style={{ width: '45%' }} />
      <div className={s.bar} style={{ width: '62%' }} />
      <div className={s.bar} style={{ width: '92%' }} />
      <div className={s.bar} style={{ width: '84%' }} />
      <div className={s.bar} style={{ width: '88%' }} />
      <p className={s.skeletonNote}>Your CV appears here, with each change marked, as soon as the rewrites are ready.</p>
    </div>
  )
}

function Waiting({ what }: { what: string }) {
  return <p className={s.waiting}>{what}</p>
}
