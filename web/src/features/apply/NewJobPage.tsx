import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { Button } from '../../ui/Button'
import { Icon } from '../../ui/Icon'
import { Notice } from '../../ui/Notice'
import { TextArea, TextField } from '../../ui/TextField'
import { useStartApplication } from './api'
import { SheetHeader } from './SheetHeader'
import { looksLikeUrl, MIN_JD_CHARS, startProblem } from './startErrors'
import { Switch } from '../../ui/Switch'
import s from './NewJobPage.module.css'

type Mode = 'text' | 'link'
const modes: { mode: Mode; label: string }[] = [
  { mode: 'text', label: 'Paste text' },
  { mode: 'link', label: 'Job link' },
]

export default function NewJobPage() {
  const [params] = useSearchParams()
  const [mode, setMode] = useState<Mode>(params.get('mode') === 'link' ? 'link' : 'text')
  const [jd, setJd] = useState('')
  const [url, setUrl] = useState('')
  const [research, setResearch] = useState(true)
  const [letter, setLetter] = useState(true)
  const [localError, setLocalError] = useState<{ field: Mode; message: string } | null>(null)
  const [clipNote, setClipNote] = useState<string | null>(null)
  const tabs = useRef<(HTMLButtonElement | null)[]>([])
  const start = useStartApplication()
  const navigate = useNavigate()

  const problem = start.isError ? startProblem(start.error) : null
  const jdError = localError?.field === 'text' ? localError.message : problem?.field === 'jd_text' ? problem.message : null
  const urlError = localError?.field === 'link' ? localError.message : problem?.field === 'url' ? problem.message : null
  const pageError = problem && problem.field === null ? problem : null

  function choose(next: Mode) {
    setMode(next)
    setLocalError(null)
  }

  function onTabKey(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const next = (i + (e.key === 'ArrowRight' ? 1 : modes.length - 1)) % modes.length
    choose(modes[next]!.mode)
    tabs.current[next]?.focus()
  }

  async function pasteFromClipboard() {
    setClipNote(null)
    try {
      const text = await navigator.clipboard.readText()
      if (!text.trim()) return setClipNote('Your clipboard is empty. Copy the job description first.')
      if (looksLikeUrl(text)) {
        setUrl(text.trim())
        choose('link')
        return
      }
      setJd(text)
    } catch {
      setClipNote('Your browser did not let us read the clipboard. Paste into the box instead.')
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    setLocalError(null)
    start.reset()
    if (mode === 'text') {
      const text = jd.trim()
      if (!text) return setLocalError({ field: 'text', message: 'Paste the job description first.' })
      if (looksLikeUrl(text)) {
        setUrl(text)
        setMode('link')
        return setLocalError({ field: 'link', message: 'That is a link, so we moved it here. Tap Tailor my CV to read it.' })
      }
      if (text.length < MIN_JD_CHARS) {
        return setLocalError({ field: 'text', message: 'That looks short for a job description. Paste the whole posting.' })
      }
      go({ jd_text: text, research, letter })
    } else {
      const link = url.trim()
      if (!looksLikeUrl(link)) return setLocalError({ field: 'link', message: 'Paste a full link starting with https://' })
      go({ url: link, research, letter })
    }
  }

  function go(input: Parameters<typeof start.mutate>[0]) {
    start.mutate(input, {
      onSuccess: (r) => navigate(`/applications/${r.application_id}/running`, { replace: true, state: { jobId: r.job_id } }),
    })
  }

  const chars = jd.trim().length
  const jdHint = chars > 0 && chars < MIN_JD_CHARS ? `${chars} characters so far. A full posting is usually much longer.` : 'More detail means a better match.'

  return (
    <form className={s.page} onSubmit={submit} noValidate>
      <SheetHeader title="New application" closeLabel="Close and go home" />

      <div className={s.body}>
        <h1 className={s.h1}>Found a job?</h1>

        <div className={s.columns}>
          <div className={s.input}>
            <div role="tablist" aria-label="How to add the job" className={s.tabs}>
              {modes.map((m, i) => (
                <button
                  key={m.mode}
                  ref={(el) => { tabs.current[i] = el }}
                  type="button"
                  role="tab"
                  id={`tab-${m.mode}`}
                  aria-selected={mode === m.mode}
                  aria-controls={`panel-${m.mode}`}
                  tabIndex={mode === m.mode ? 0 : -1}
                  className={s.tab}
                  onClick={() => choose(m.mode)}
                  onKeyDown={(e) => onTabKey(e, i)}
                >
                  {m.label}
                </button>
              ))}
            </div>

            {mode === 'text' ? (
              <div role="tabpanel" id="panel-text" aria-labelledby="tab-text" className={s.panel}>
                <TextArea
                  label="Job description"
                  placeholder="Paste the whole description, from the job title to the benefits."
                  value={jd}
                  onChange={(e) => setJd(e.target.value)}
                  rows={10}
                  className={s.jd}
                  hint={jdHint}
                  error={jdError}
                />
                <Button variant="secondary" small onClick={pasteFromClipboard} className={s.paste}>
                  <Icon name="copy" size={18} strokeWidth={1.8} />
                  Paste from clipboard
                </Button>
                {clipNote && <p className={s.note} role="status">{clipNote}</p>}
              </div>
            ) : (
              <div role="tabpanel" id="panel-link" aria-labelledby="tab-link" className={s.panel}>
                <TextField
                  label="Link to the job"
                  type="url"
                  inputMode="url"
                  placeholder="https://"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  hint="We read the page for you. If a site blocks us, we will ask you to paste the text."
                  error={urlError}
                />
                {problem?.pasteInstead && (
                  <Button variant="secondary" small onClick={() => choose('text')} className={s.paste}>
                    Paste the text instead
                  </Button>
                )}
              </div>
            )}
          </div>

          <div className={s.side}>
            <section aria-labelledby="what-we-do" className={s.options}>
              <h2 id="what-we-do" className="visually-hidden">What we will do</h2>
              <div className={s.option}>
                <span className={s.optionLabel}>Tailor CV and score it</span>
                <span className={s.always}>Always</span>
              </div>
              <div className={s.option}>
                <label htmlFor="opt-research" className={s.optionLabel}>Research the company</label>
                <Switch id="opt-research" checked={research} onChange={setResearch} label="Research the company" />
              </div>
              <div className={s.option}>
                <label htmlFor="opt-letter" className={s.optionLabel}>Draft a cover letter</label>
                <Switch id="opt-letter" checked={letter} onChange={setLetter} label="Draft a cover letter" />
              </div>
            </section>

            <p className={s.promise}>Every change is a suggestion. Nothing reaches your CV until you choose it.</p>

            {pageError && (
              <Notice tone="error">
                {pageError.message}{' '}
                {pageError.action && <Link to={pageError.action.to}>{pageError.action.label}</Link>}
              </Notice>
            )}

            <div className={s.footer}>
              <Button type="submit" block busy={start.isPending}>
                Tailor my CV
                {!start.isPending && <Icon name="arrowRight" size={18} strokeWidth={2} />}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </form>
  )
}
