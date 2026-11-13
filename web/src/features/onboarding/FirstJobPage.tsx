import { useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router'
import { useUsage, type Usage } from '../../app/UsageCard'
import { profileKey } from '../../auth/session'
import { Button } from '../../ui/Button'
import { Notice } from '../../ui/Notice'
import { TextArea } from '../../ui/TextField'
import { useStartApplication, type StartInput } from '../apply/api'
import { looksLikeUrl, MIN_JD_CHARS, startProblem } from '../apply/startErrors'
import { toFormError } from '../auth/errors'
import { useFinishOnboarding, useMaster } from './api'
import { CvSheet } from './components/CvSheet'
import { OnboardFrame } from './components/OnboardFrame'
import s from './FirstJobPage.module.css'

/** "Uses 1 of your 10 applications this month", from GET /v1/usage. Nothing when the plan has no limit. */
export function usageLine(u: Usage | undefined): string | null {
  if (!u || u.monthly_limit === null) return null
  const left = Math.max(0, u.monthly_limit - u.applications_this_month)
  if (left === 0) return `You have used all ${u.monthly_limit} applications this month.`
  if (u.applications_this_month === 0) return `Uses 1 of your ${u.monthly_limit} applications this month`
  return `Uses 1 of the ${left} applications you have left this month`
}

export default function FirstJobPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const master = useMaster()
  const usage = useUsage()
  const start = useStartApplication()
  const finish = useFinishOnboarding()
  const [text, setText] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const [finishError, setFinishError] = useState<{ message: string; then: () => void } | null>(null)
  const [finishing, setFinishing] = useState(false)

  /**
   * Mark onboarding done, then leave. While this runs the frame is told not
   * to redirect Home on its own when it sees the step turn to done.
   */
  async function finishThen(go: () => void) {
    setFinishError(null)
    setFinishing(true)
    try {
      const profile = await finish.mutateAsync()
      qc.setQueryData(profileKey, profile)
      go()
    } catch (err) {
      setFinishing(false)
      setFinishError({ message: toFormError(err).message, then: go })
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    setLocalError(null)
    start.reset()
    const value = text.trim()
    if (!value) return setLocalError('Paste a job link or the job description first.')
    let input: StartInput
    if (looksLikeUrl(value)) input = { url: value, research: true, letter: true }
    else if (value.length < MIN_JD_CHARS) return setLocalError('That looks short for a job description. Paste the whole posting, or a link to it.')
    else input = { jd_text: value, research: true, letter: true }
    start.mutate(input, {
      onSuccess: (r) =>
        void finishThen(() => navigate(`/applications/${r.application_id}/running`, { replace: true, state: { jobId: r.job_id } })),
    })
  }

  const problem = start.isError ? startProblem(start.error) : null
  const fieldError = localError ?? (problem && problem.field ? problem.message : null)
  const pageProblem = problem && !problem.field ? problem : null
  // During onboarding the plan page is out of reach; Home is the way on.
  const action = pageProblem?.action && pageProblem.action.to.startsWith('/onboarding') ? pageProblem.action : null
  const line = usageLine(usage.data)
  const busy = start.isPending || finish.isPending

  return (
    <OnboardFrame
      step="first_job"
      finishing={finishing}
      back="/onboarding/targets"
      aside={master.data ? <CvSheet contained doc={master.data.doc} /> : undefined}
      footer={
        <>
          {finishError && (
            <Notice tone="error">
              {finishError.message}{' '}
              <button type="button" className={s.inlineButton} onClick={() => finishThen(finishError.then)}>Try again</button>
            </Notice>
          )}
          <Button type="submit" form="first-job" block busy={start.isPending}>Tailor my CV</Button>
          <button type="button" data-quiet className={s.skip} disabled={busy} onClick={() => finishThen(() => navigate('/', { replace: true }))}>
            No job in mind yet? Go to Home
          </button>
          {line && <p className={s.usage}>{line}</p>}
        </>
      }
    >
      <form id="first-job" className={s.form} onSubmit={submit} noValidate>
        <div className={s.heading}>
          <h1 className={s.title}>Now the good part. Which job?</h1>
          <p className={s.lede}>Paste a link or the whole description. We will tailor your CV to it and tell you how well you match.</p>
        </div>
        <TextArea
          label="Job link or description"
          rows={6}
          className={s.jd}
          placeholder="https://... or paste the posting"
          value={text}
          onChange={(e) => setText(e.target.value)}
          error={fieldError}
          hint={problem?.pasteInstead ? undefined : 'A link works for most job sites. If one blocks us, we will ask for the text.'}
        />
        {pageProblem && (
          <Notice tone="error">
            {pageProblem.message} {action && <Link to={action.to}>{action.label}</Link>}
          </Notice>
        )}
        <section className={s.promise} aria-labelledby="you-get">
          <h2 id="you-get" className={s.kicker}>In about two minutes you get</h2>
          <ul className={s.list}>
            <li>A match score, and what is missing</li>
            <li>Rewrites of your bullets for this job, each one yours to accept</li>
            <li>A short read on the company and a cover letter draft</li>
          </ul>
        </section>
      </form>
    </OnboardFrame>
  )
}
