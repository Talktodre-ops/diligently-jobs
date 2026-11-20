import { isApiError } from '../../api/client'
import { Button, ButtonLink } from '../../ui/Button'
import { Icon } from '../../ui/Icon'
import { Notice } from '../../ui/Notice'
import { useRetryPipeline, type Step } from './api'
import s from './Progress.module.css'

type Props = {
  id: string
  steps: Step[]
  status: 'queued' | 'running' | 'failed'
  /** The job read a link and the link was the part that failed. */
  linkFailed: boolean
  onRetried: (jobId: string) => void
  onAlreadyRetried: () => void
}

/**
 * Tailoring, shown in place at the top of the application while it runs, and
 * what to do when it stops partway. Steps that worked are kept on a retry.
 */
export function Progress({ id, steps, status, linkFailed, onRetried, onAlreadyRetried }: Props) {
  const retry = useRetryPipeline(id)
  const failed = status === 'failed'
  const running = steps.find((x) => x.status === 'running')

  function onRetry() {
    retry.mutate(undefined, {
      onSuccess: (r) => onRetried(r.job_id),
      onError: (e) => {
        // Someone (another tab, the automatic retry) got there first.
        if (isApiError(e, 'pipeline_not_failed')) onAlreadyRetried()
      },
    })
  }

  return (
    <section aria-labelledby="progress-title" className={failed ? s.cardFailed : s.card}>
      <div className={s.head}>
        <h2 id="progress-title" className={s.title}>{failed ? 'That stopped partway' : 'Tailoring your CV'}</h2>
        {!failed && <span className={s.when}>Usually a minute or two</span>}
      </div>
      <p className="visually-hidden" role="status" aria-live="polite">
        {failed ? 'Stopped.' : running ? `${running.label}.` : 'Starting.'}
      </p>
      {failed && (
        <p className={s.sub}>
          {linkFailed
            ? 'We could not read that link. Some sites block us. Paste the job description and we will start again.'
            : 'One step did not finish. Steps that worked are kept, so trying again only redoes the rest.'}
        </p>
      )}
      <ol aria-label="Progress" className={s.steps}>
        {steps.map((step) => (
          <StepRow key={step.key} step={step} jobFailed={failed} />
        ))}
      </ol>
      {failed ? (
        <div className={s.actions}>
          {retry.isError && !isApiError(retry.error, 'pipeline_not_failed') && (
            <Notice tone="error">{isApiError(retry.error) ? retry.error.message : 'That did not work. Try again.'}</Notice>
          )}
          {linkFailed ? (
            <>
              <ButtonLink to="/new?mode=text" small>Paste the text instead</ButtonLink>
              <Button variant="secondary" small busy={retry.isPending} onClick={onRetry}>Try the link again</Button>
            </>
          ) : (
            <Button small busy={retry.isPending} onClick={onRetry}>
              <Icon name="refresh" size={16} strokeWidth={2} />
              Try again
            </Button>
          )}
        </div>
      ) : (
        <p className={s.note}>You can leave. It keeps going, and Home shows it when it is ready.</p>
      )}
    </section>
  )
}

function StepRow({ step, jobFailed }: { step: Step; jobFailed: boolean }) {
  // A step marked failed while the job is still alive is being retried automatically.
  const state = step.status === 'failed' && !jobFailed ? 'running' : step.status
  const note = { pending: 'Waiting', running: step.status === 'failed' ? 'Trying again' : 'In progress', done: 'Done', skipped: 'Skipped', failed: 'Did not finish' }[state]
  return (
    <li className={s.step} data-state={state}>
      <span className={s.mark} aria-hidden="true">
        {state === 'done' && <Icon name="check" size={13} strokeWidth={3} />}
        {state === 'failed' && <Icon name="close" size={13} strokeWidth={3} />}
      </span>
      <span className={s.label}>
        {step.label}
        <span className="visually-hidden">: {note}</span>
      </span>
      {(state === 'skipped' || state === 'failed' || (state === 'running' && step.status === 'failed')) && (
        <span className={s.stepNote} aria-hidden="true">{note}</span>
      )}
    </li>
  )
}
