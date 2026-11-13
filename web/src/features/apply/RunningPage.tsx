import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Navigate, useLocation, useParams } from 'react-router'
import { isApiError } from '../../api/client'
import { Button, ButtonLink } from '../../ui/Button'
import { Icon } from '../../ui/Icon'
import { Notice } from '../../ui/Notice'
import { PageState } from '../../ui/PageState'
import { keys, useBrief, usePipelineJob, useRetryPipeline, type Brief, type Step } from './api'
import { countWord } from './format'
import { SheetHeader } from './SheetHeader'
import s from './RunningPage.module.css'

/**
 * The live step list for one application's pipeline. Everything it needs
 * comes from the server (the brief names the job, the job carries progress),
 * so a reload or a visit from Home picks up exactly where it was.
 */
export default function RunningPage() {
  const { id = '' } = useParams()
  const location = useLocation()
  const qc = useQueryClient()
  const brief = useBrief(id)
  const [retriedJob, setRetriedJob] = useState<string | null>(null)
  const passedJob = (location.state as { jobId?: string } | null)?.jobId
  const jobId = retriedJob ?? brief.data?.pipeline?.job_id ?? passedJob ?? null
  const job = usePipelineJob(jobId)
  const retry = useRetryPipeline(id)

  const steps: Step[] = job.data?.progress ?? brief.data?.pipeline?.progress ?? []
  const status = job.data?.status ?? brief.data?.pipeline?.status
  const doneCount = steps.filter((x) => x.status === 'done').length

  // The brief learns the company after the first step and the score at the
  // end; refresh it as steps finish.
  useEffect(() => {
    if (doneCount > 0 || status === 'done' || status === 'failed') {
      qc.invalidateQueries({ queryKey: keys.brief(id) })
    }
  }, [doneCount, status, id, qc])

  if (brief.isPending) return <PageState.Loading />
  if (brief.isError) {
    if (isApiError(brief.error, 'not_found')) return <PageState.Empty title="Application not found" body="It may have been deleted." />
    return <PageState.Error error={brief.error} onRetry={() => brief.refetch()} />
  }
  // An application made before the pipeline existed has nothing to watch.
  if (!jobId) return <Navigate to={`/applications/${id}`} replace />

  const app = brief.data.application
  const heading = app.company ? [app.company, app.role].filter(Boolean).join(' · ') : 'New application'
  const linkFailed = status === 'failed' && !!app.source_url && steps.some((x) => x.key === 'read_job' && x.status === 'failed')
  const running = steps.find((x) => x.status === 'running')

  function onRetry() {
    retry.mutate(undefined, {
      onSuccess: (r) => setRetriedJob(r.job_id),
      onError: (e) => {
        // Someone (another tab, the automatic retry) got there first.
        if (isApiError(e, 'pipeline_not_failed')) brief.refetch()
      },
    })
  }

  return (
    <div className={s.page}>
      <SheetHeader title={<span className={s.eyebrow}>{heading}</span>} closeLabel="Close and keep working in the background" />
      <div className={s.body}>
        <div className={s.intro}>
          <h1 className={s.h1}>{status === 'done' ? 'Ready.' : status === 'failed' ? 'That stopped partway' : 'Working on it'}</h1>
          <p className={s.sub}>{subtitle(status, brief.data, linkFailed)}</p>
          <p className="visually-hidden" role="status" aria-live="polite">
            {status === 'done' ? 'Finished.' : status === 'failed' ? 'Stopped.' : running ? `${running.label}.` : 'Starting.'}
          </p>
        </div>

        <ol aria-label="Progress" className={s.steps}>
          {steps.map((step, i) => (
            <StepRow key={step.key} step={step} last={i === steps.length - 1} jobFailed={status === 'failed'} />
          ))}
        </ol>

        <div className={s.footer}>
          {status === 'done' && (
            <ButtonLink to={`/applications/${id}`} block>
              See your application
              <Icon name="arrowRight" size={18} strokeWidth={2} />
            </ButtonLink>
          )}
          {status === 'failed' && (
            <>
              {retry.isError && !isApiError(retry.error, 'pipeline_not_failed') && (
                <Notice tone="error">{isApiError(retry.error) ? retry.error.message : 'That did not work. Try again.'}</Notice>
              )}
              {linkFailed ? (
                <>
                  <ButtonLink to="/new?mode=text" block>Paste the text instead</ButtonLink>
                  <Button variant="secondary" block busy={retry.isPending} onClick={onRetry}>Try the link again</Button>
                </>
              ) : (
                <Button block busy={retry.isPending} onClick={onRetry}>
                  <Icon name="refresh" size={18} strokeWidth={2} />
                  Try again
                </Button>
              )}
            </>
          )}
          {status !== 'done' && status !== 'failed' && (
            <div className={s.background}>
              <Icon name="alert" size={18} strokeWidth={1.8} className={s.bgIcon} />
              <span>You can close this. It keeps going, and Home will show it when it is ready.</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function subtitle(status: string | undefined, brief: Brief, linkFailed: boolean) {
  if (status === 'done') {
    const { before, current, projected, pending } = brief.score
    const parts: string[] = []
    const after = projected != null && before != null ? Math.max(projected, before) : current
    if (before != null && after != null && after > before) parts.push(`Your match could go from ${before} to ${after}.`)
    else if (before != null) parts.push(`Your match is ${before}.`)
    if (pending > 0) parts.push(`${countWord(pending)} ${pending === 1 ? 'rewrite is' : 'rewrites are'} waiting for your call.`)
    else parts.push('Nothing is waiting for you.')
    return parts.join(' ')
  }
  if (status === 'failed') {
    if (linkFailed) return 'We could not read that link. Some sites block us. Paste the job description and we will start again.'
    return 'One step did not finish. Steps that worked are kept, so trying again only redoes the rest.'
  }
  return 'Usually a minute or two. Every change is checked against your master CV.'
}

function StepRow({ step, last, jobFailed }: { step: Step; last: boolean; jobFailed: boolean }) {
  // A step marked failed while the job is still alive is being retried automatically.
  const state = step.status === 'failed' && !jobFailed ? 'running' : step.status
  const note = { pending: 'Waiting', running: step.status === 'failed' ? 'Trying again' : 'In progress', done: 'Done', skipped: 'Skipped', failed: 'Did not finish' }[state]
  return (
    <li className={s.step} data-state={state}>
      <div className={s.rail}>
        <span className={s.mark} aria-hidden="true">
          {state === 'done' && <Icon name="check" size={16} strokeWidth={2.6} />}
          {state === 'failed' && <Icon name="close" size={16} strokeWidth={2.6} />}
        </span>
        {!last && <span className={s.line} />}
      </div>
      <div className={s.stepText}>
        <div className={s.stepLabel}>
          {step.label}
          <span className="visually-hidden">: {note}</span>
        </div>
        {(state === 'skipped' || state === 'failed' || (state === 'running' && step.status === 'failed')) && (
          <div className={s.stepNote} aria-hidden="true">{note}</div>
        )}
      </div>
    </li>
  )
}
