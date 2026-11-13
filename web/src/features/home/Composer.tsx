import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { Button } from '../../ui/Button'
import { Icon } from '../../ui/Icon'
import { useStartApplication } from '../apply/api'
import { looksLikeUrl, MIN_JD_CHARS, startProblem } from '../apply/startErrors'
import s from './HomePage.module.css'

/**
 * Desktop Home banner: paste a link or a description and go straight to the
 * Running screen. Research and the letter are on, as on New job by default.
 */
export function Composer({ title, line }: { title: string; line: string }) {
  const [value, setValue] = useState('')
  const [local, setLocal] = useState<string | null>(null)
  const start = useStartApplication()
  const navigate = useNavigate()
  const problem = start.isError ? startProblem(start.error) : null

  function submit(e: FormEvent) {
    e.preventDefault()
    const v = value.trim()
    setLocal(null)
    start.reset()
    if (!v) return setLocal('Paste a job link or the job description.')
    const isUrl = looksLikeUrl(v)
    if (!isUrl && v.length < MIN_JD_CHARS) {
      return setLocal('That looks short for a job description. Paste the whole posting, or a link to it.')
    }
    const input = isUrl ? { url: v, research: true, letter: true } : { jd_text: v, research: true, letter: true }
    start.mutate(input, {
      onSuccess: (r) => navigate(`/applications/${r.application_id}/running`, { state: { jobId: r.job_id } }),
    })
  }

  const message = local ?? problem?.message
  return (
    <section aria-label="New application" className={s.composer}>
      <div className={s.composerText}>
        <h1 className={s.composerTitle}>{title}</h1>
        <p className={s.composerLine}>{line}</p>
      </div>
      <form className={s.composerForm} onSubmit={submit} noValidate>
        <label htmlFor="composer-jd" className="visually-hidden">Job link or description</label>
        <textarea
          id="composer-jd"
          className={s.composerInput}
          rows={1}
          placeholder="Paste a job link or description"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-invalid={message ? true : undefined}
          aria-describedby={message ? 'composer-error' : undefined}
        />
        <Button type="submit" busy={start.isPending}>
          Tailor my CV
          {!start.isPending && <Icon name="arrowRight" size={18} strokeWidth={2} />}
        </Button>
        {message && (
          <p id="composer-error" className={s.composerError} role="alert">
            {message}{' '}
            {problem?.action && <Link to={problem.action.to}>{problem.action.label}</Link>}
            {problem?.pasteInstead && <Link to="/new">Paste the text instead</Link>}
          </p>
        )}
        <div className={s.composerMoreRow}>
          <Link to="/new" className={s.composerMore}>More options</Link>
        </div>
      </form>
    </section>
  )
}
