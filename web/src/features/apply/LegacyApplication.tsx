import { Link, useNavigate } from 'react-router'
import { Button } from '../../ui/Button'
import { Notice } from '../../ui/Notice'
import { TopBar } from '../../ui/TopBar'
import { useTailorAgain, type Brief } from './api'
import { startProblem } from './startErrors'
import s from './ApplicationPage.module.css'

/**
 * An application carried over from the desktop app. It has no base CV, so
 * there are no changes, score or files to show; it can be tailored again
 * into a new application from its saved posting.
 */
export function LegacyApplication({ brief, desktop }: { brief: Brief; desktop: boolean }) {
  const navigate = useNavigate()
  const again = useTailorAgain(brief.application.id)
  const a = brief.application
  const role = a.role ?? 'Saved job'
  const company = a.company?.trim() || null
  const problem = again.isError ? startProblem(again.error) : null
  const tailored = a.retailored_to

  const go = () => again.mutate(undefined, { onSuccess: (r) => navigate(`/applications/${r.application_id}`) })

  const body = (
    <section className={s.legacy} aria-labelledby="legacy-title">
      <h2 id="legacy-title" className={s.legacyTitle}>
        {tailored ? 'Tailored again with your current CV' : 'Saved from the desktop app'}
      </h2>
      <p className={s.legacyText}>
        {tailored
          ? 'This is the earlier copy, kept for its history. The new one has the changes, the match score and the files.'
          : 'This job was saved before your CV lived here, so it has no changes, match score or files yet. Tailor it again with your current CV to get them. This copy keeps its history.'}
      </p>
      {problem && (
        <Notice tone="error">
          {problem.message} {problem.action && <Link to={problem.action.to}>{problem.action.label}</Link>}
        </Notice>
      )}
      <div className={s.legacyActions}>
        {tailored ? (
          <Link to={`/applications/${tailored}`} className={s.legacyOpen}>Open the tailored version</Link>
        ) : (
          <Button onClick={go} disabled={again.isPending}>{again.isPending ? 'Starting' : 'Tailor again'}</Button>
        )}
        {a.source_url && <a href={a.source_url} target="_blank" rel="noreferrer">See the posting</a>}
      </div>
    </section>
  )

  if (desktop) {
    return (
      <div className={s.desk}>
        <header className={s.deskHead}>
          <div className={s.deskTitles}>
            <Link to="/jobs" className={s.crumb}>All jobs</Link>
            <h1 className={s.deskH1}>{role}</h1>
            {company && <div className={s.deskWhere}>{company}</div>}
          </div>
        </header>
        {body}
      </div>
    )
  }
  return (
    <div className={s.page}>
      <TopBar back="/jobs" backLabel="Back to jobs" eyebrow={company ?? undefined} title={role} />
      <div className={s.body}>{body}</div>
    </div>
  )
}
