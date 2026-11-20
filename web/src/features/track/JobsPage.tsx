import { useState } from 'react'
import { Link } from 'react-router'
import { isApiError } from '../../api/client'
import { ButtonLink } from '../../ui/Button'
import { Icon } from '../../ui/Icon'
import { Notice } from '../../ui/Notice'
import { PageState } from '../../ui/PageState'
import {
  ago, monogram, STAGES, useApplications, useDueFollowUps, useMatchScore, useSetStage,
  type Stage, type TrackedApp,
} from './api'
import s from './JobsPage.module.css'

function sentLine(a: TrackedApp) {
  switch (a.stage) {
    case 'saved': return `Started ${ago(a.created_at)}`
    case 'applied': return `Sent ${ago(a.submitted_at ?? a.updated_at)}`
    case 'interviewing': return `Moved ${ago(a.updated_at)}`
    case 'offer': return `Offer ${ago(a.updated_at)}`
    case 'closed': return `Closed ${ago(a.updated_at)}`
  }
}

export function JobCard({ app, dueFollowUp, onMove, moving }: { app: TrackedApp; dueFollowUp: boolean; onMove: (stage: Stage) => void; moving: boolean }) {
  const score = useMatchScore(app.id, app.status !== 'failed')
  const name = app.company || 'Untitled job'
  return (
    <li className={s.card}>
      <Link to={`/applications/${app.id}`} className={s.open} aria-label={`Open ${name}${app.role ? `, ${app.role}` : ''}`}>
        <span className={s.mono} aria-hidden="true">{monogram(app.company)}</span>
        <span className={s.who}>
          <span className={s.company}>{name}</span>
          <span className={s.role}>{app.role || 'Role not read yet'}</span>
        </span>
        {score.data != null && (
          <span className={s.score}><strong>{score.data}</strong><span>match</span></span>
        )}
      </Link>
      <div className={s.meta}>
        <span>{sentLine(app)}</span>
        {dueFollowUp && app.stage === 'applied' && (
          <Link to={`/applications/${app.id}/follow-up`} className={s.next}>Follow up today</Link>
        )}
      </div>
      <label className={s.move}>
        <span>Move to</span>
        <select value={app.stage} disabled={moving} onChange={(e) => onMove(e.target.value as Stage)} aria-label={`Move ${name} to a stage`}>
          {STAGES.map((st) => <option key={st.id} value={st.id}>{st.label}</option>)}
        </select>
      </label>
    </li>
  )
}

export default function JobsPage() {
  const apps = useApplications()
  const due = useDueFollowUps()
  const setStage = useSetStage()
  const [picked, setPicked] = useState<Stage>('applied')

  const all = apps.data ?? []
  const by = (st: Stage) => all.filter((a) => a.stage === st)

  return (
    <div className={s.page}>
      <header className={s.head}>
        <h1>Jobs</h1>
        <ButtonLink to="/new" small className={s.newTop}><Icon name="plus" size={18} />New job</ButtonLink>
      </header>

      {apps.isPending && <PageState.Loading />}
      {apps.isError && <PageState.Error error={apps.error} onRetry={() => apps.refetch()} />}

      {apps.data && all.length === 0 && (
        <PageState.Empty
          title="No jobs yet"
          body="Paste a job link or description and we will tailor your CV. Every job you start shows up here, grouped by where it stands."
          action={<ButtonLink to="/new">Start your first job</ButtonLink>}
        />
      )}

      {apps.data && all.length > 0 && (
        <>
          {setStage.isError && (
            <div className={s.notice}>
              <Notice tone="error">{isApiError(setStage.error) ? setStage.error.message : 'Could not move that job. Try again.'}</Notice>
            </div>
          )}
          <div role="tablist" aria-label="Stages" className={s.tabs}>
            {STAGES.map((st) => (
              <button
                key={st.id}
                type="button"
                role="tab"
                id={`tab-${st.id}`}
                aria-selected={picked === st.id}
                aria-controls={`panel-${st.id}`}
                className={s.tab}
                onClick={() => setPicked(st.id)}
              >
                {st.label} <span className={s.count}>{by(st.id).length}</span>
              </button>
            ))}
          </div>
          <div className={s.board}>
            {STAGES.map((st) => {
              const list = by(st.id)
              return (
                <section
                  key={st.id}
                  id={`panel-${st.id}`}
                  role="tabpanel"
                  aria-labelledby={`tab-${st.id}`}
                  className={[s.column, picked === st.id && s.shown].filter(Boolean).join(' ')}
                >
                  <h2 className={s.colHead}>{st.label} <span className={s.count}>{list.length}</span></h2>
                  {list.length === 0 ? (
                    <div className={s.empty}>
                      <div className={s.emptyTitle}>{st.empty.title}</div>
                      <div>{st.empty.body}</div>
                    </div>
                  ) : (
                    <ul className={s.list}>
                      {list.map((a) => (
                        <JobCard
                          key={a.id}
                          app={a}
                          dueFollowUp={due.data?.has(a.id) ?? false}
                          moving={setStage.isPending && setStage.variables?.id === a.id}
                          onMove={(stage) => setStage.mutate({ id: a.id, stage })}
                        />
                      ))}
                    </ul>
                  )}
                </section>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
