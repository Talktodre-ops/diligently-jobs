import { Link, Navigate, useParams } from 'react-router'
import { isApiError } from '../../api/client'
import { ButtonLink } from '../../ui/Button'
import { Icon } from '../../ui/Icon'
import { Notice } from '../../ui/Notice'
import { PageState } from '../../ui/PageState'
import { TopBar } from '../../ui/TopBar'
import { companyName, useBrief, type Brief } from './api'
import { briefRows, scoreStatus, type BriefRow } from './briefRows'
import { CvPaper } from './CvPaper'
import { InlineRewrites } from './InlineRewrites'
import { ScoreCard } from './ScoreCard'
import { DESKTOP, useMediaQuery } from '../../ui/useMediaQuery'
import s from './WorkspacePage.module.css'

/** One application: where the match stands and what is left to decide. */
export default function WorkspacePage() {
  const { id = '' } = useParams()
  const brief = useBrief(id)
  const desktop = useMediaQuery(DESKTOP)

  if (brief.isPending) return <PageState.Loading />
  if (brief.isError) {
    if (isApiError(brief.error, 'not_found')) {
      return <PageState.Empty title="Application not found" body="It may have been deleted." action={<Link to="/">Go home</Link>} />
    }
    return <PageState.Error error={brief.error} onRetry={() => brief.refetch()} />
  }
  const b = brief.data
  const pipeline = b.pipeline?.status
  // Still tailoring: the live step list is the useful screen.
  if (pipeline === 'queued' || pipeline === 'running') return <Navigate to={`/applications/${id}/running`} replace />

  return desktop ? <Desktop id={id} b={b} /> : <Mobile id={id} b={b} />
}

function Stopped({ id }: { id: string }) {
  return (
    <Notice tone="error">
      Tailoring stopped before it finished. <Link to={`/applications/${id}/running`}>See what happened</Link>
    </Notice>
  )
}

function Mobile({ id, b }: { id: string; b: Brief }) {
  const rows = briefRows(id, b)
  return (
    <div className={s.page}>
      <TopBar back="/" backLabel="Back to home" eyebrow={companyName(b.application.company)} title={b.application.role ?? 'Application'} />
      <div className={s.body}>
        {b.pipeline?.status === 'failed' && <Stopped id={id} />}
        <ScoreCard score={b.score} status={scoreStatus(b)} />
        <ul className={s.rows}>
          {rows.map((r) => (
            <li key={r.key}>
              <RowCard row={r} />
            </li>
          ))}
        </ul>
        <FollowUpNote />
      </div>
      <div className={s.footer}>
        <ButtonLink to={`/applications/${id}/cv`} variant="secondary" className={s.preview}>Preview CV</ButtonLink>
        <ButtonLink to={`/applications/${id}/send`} className={s.send}>
          <Icon name="send" size={18} strokeWidth={2} />
          Send CV
        </ButtonLink>
      </div>
    </div>
  )
}

function RowCard({ row }: { row: BriefRow }) {
  return (
    <Link to={row.to} className={s.rowCard}>
      <span className={`${s.rowIcon} ${s[row.tone]}`} aria-hidden="true">
        <Icon name={row.icon} size={20} strokeWidth={1.8} />
      </span>
      <span className={s.rowText}>
        <span className={s.rowTitle}>{row.title}</span>
        <span className={s.rowSub}>{row.sub}</span>
      </span>
      <span className={s.rowAction}>{row.action}</span>
    </Link>
  )
}

function FollowUpNote() {
  return (
    <p className={s.note}>
      <Icon name="calendar" size={16} strokeWidth={1.8} />
      We will remind you to follow up 7 days after you send.
    </p>
  )
}

function Desktop({ id, b }: { id: string; b: Brief }) {
  // The CV row is replaced by the inline rewrites on desktop.
  const rows = briefRows(id, b).filter((r) => r.key !== 'cv')
  const where = [companyName(b.application.company), b.application.location].filter(Boolean).join(' · ')
  return (
    <div className={s.desk}>
      <header className={s.deskHead}>
        <div className={s.deskTitles}>
          <Link to="/jobs" className={s.crumb}>All jobs</Link>
          <h1 className={s.deskH1}>{b.application.role ?? 'Application'}</h1>
          <div className={s.deskWhere}>{where}</div>
        </div>
        <div className={s.deskActions}>
          <ButtonLink to={`/applications/${id}/cv`} variant="secondary">Preview CV</ButtonLink>
          <ButtonLink to={`/applications/${id}/send`}>
            <Icon name="send" size={18} strokeWidth={2} />
            Send CV
          </ButtonLink>
        </div>
      </header>
      {b.pipeline?.status === 'failed' && <Stopped id={id} />}
      <div className={s.deskCols}>
        <div className={s.deskLeft}>
          <ScoreCard score={b.score} status={scoreStatus(b)} compact />
          <InlineRewrites id={id} />
          <ul className={s.list}>
            {rows.map((r) => (
              <li key={r.key}>
                <Link to={r.to} className={s.listRow}>
                  <span className={s.listText}>
                    <span className={s.listTitle}>{r.title}</span>
                    <span className={s.listSub}>{r.sub}</span>
                  </span>
                  <span className={s.rowAction}>{r.action}</span>
                </Link>
              </li>
            ))}
          </ul>
          <FollowUpNote />
        </div>
        <CvPaper id={id} />
      </div>
    </div>
  )
}
