import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { Button, ButtonLink } from '../../ui/Button'
import { Icon } from '../../ui/Icon'
import { Notice } from '../../ui/Notice'
import { PageState } from '../../ui/PageState'
import { TextArea, TextField } from '../../ui/TextField'
import { DESKTOP, useMediaQuery } from '../../ui/useMediaQuery'
import { toFormError } from '../auth/errors'
import { useMaster, useSaveMaster, useUpdateProfile, type Issue, type MasterCv, type ResumeDoc } from './api'
import { CvSheet } from './components/CvSheet'
import { IssueCard } from './components/IssueCards'
import { OnboardFrame } from './components/OnboardFrame'
import { mergeAnswer, strengthenCandidates, type Candidate } from './cvFacts'
import s from './CheckPage.module.css'

/** One line saying what a saved fix changed, shown where the card was. */
function fixSummary(path: string, doc: ResumeDoc): string {
  const role = path.match(/^experience\[(\d+)\]/)
  if (role) {
    const e = doc.experience[Number(role[1])]
    if (!e) return 'Saved'
    if (path.endsWith('.bullets')) return `${e.company || e.role}, ${e.bullets.length} ${e.bullets.length === 1 ? 'line' : 'lines'} added`
    return `${e.company || e.role}, ${e.start} to ${e.end}`
  }
  if (path === 'header.title') return `Headline: ${doc.header.title}`
  if (path === 'header.email') return `Email: ${doc.header.email ?? ''}`
  if (path === 'experience') {
    const e = doc.experience[doc.experience.length - 1]
    return e ? `Added ${[e.role, e.company].filter(Boolean).join(' at ')}` : 'Saved'
  }
  if (path === 'skills') return `Skills: ${doc.skills.flatMap((g) => g.items).slice(0, 6).join(', ')}`
  return 'Saved'
}

function headingFor(issues: number, questions: number): { title: string; lede: string } {
  const fixes = issues === 1 ? 'One fix' : 'A few fixes'
  if (issues > 0 && questions > 0) return { title: 'Two quick things', lede: `${fixes}, then a chance to make every tailored CV stronger.` }
  if (issues > 0) return { title: 'One quick check', lede: `${fixes} and your CV is ready to tailor.` }
  if (questions > 0) return { title: 'One quick thing', lede: 'Nothing to fix. Add a few numbers and every tailored CV gets stronger.' }
  return { title: 'Your CV is ready', lede: 'Nothing to fix and nothing missing. On to what you want.' }
}

export default function CheckPage() {
  const master = useMaster()
  const cv = master.data
  if (cv) return <CheckBody cv={cv} />
  return (
    <OnboardFrame step="check" back="/onboarding/upload" aside={<CvSheet contained doc={null} />}>
      {master.isPending && <PageState.Loading />}
      {master.isError && <PageState.Error error={master.error} onRetry={() => master.refetch()} />}
      {master.isSuccess && (
        <PageState.Empty title="No CV yet" body="Bring your CV first so there is something to check." action={<ButtonLink to="/onboarding/upload">Bring your CV</ButtonLink>} />
      )}
    </OnboardFrame>
  )
}

function CheckBody({ cv }: { cv: MasterCv }) {
  const navigate = useNavigate()
  const save = useSaveMaster()
  const updateProfile = useUpdateProfile()
  const desktop = useMediaQuery(DESKTOP)
  // The questions are picked once, so answering one does not reshuffle the rest.
  const [questions, setQuestions] = useState<Candidate[]>(() => strengthenCandidates(cv.doc))
  const [index, setIndex] = useState(0)
  const [added, setAdded] = useState<string[]>([])
  const [fixed, setFixed] = useState<{ path: string; text: string }[]>([])
  const [showCv, setShowCv] = useState(false)
  // The heading describes the screen as it opened; it does not change under the user as they fix things.
  const [head] = useState(() => headingFor(cv.issues.length, strengthenCandidates(cv.doc).length))
  const [error, setError] = useState<string | null>(null)

  const issues = cv.issues
  const current = questions[index] ?? null

  async function fix(issue: Issue, doc: ResumeDoc) {
    const saved = await save.mutateAsync(doc)
    setFixed((f) => [...f, { path: issue.path, text: fixSummary(issue.path, saved.doc) }])
    // Fixing a role's bullets can make new strengthen questions possible; only add, never reorder.
    setQuestions((q) => {
      if (index < q.length) return q
      const more = strengthenCandidates(saved.doc).filter((c) => !q.some((x) => x.key === c.key))
      return [...q, ...more].slice(0, 3)
    })
  }

  async function next() {
    setError(null)
    try {
      await updateProfile.mutateAsync({ onboarding_step: 'targets' })
      navigate('/onboarding/targets')
    } catch (e) {
      setError(toFormError(e).message)
    }
  }

  const blocked = issues.length > 0
  const allDates = issues.every((i) => /^experience\[\d+\]$/.test(i.path))
  const ctaLabel = !blocked ? 'Continue' : allDates ? 'Fix the dates to continue' : `Fix ${issues.length === 1 ? 'this' : 'these'} to continue`

  const marks = { fix: issues.map((i) => i.path), strengthen: current?.key ?? null, added }

  return (
    <OnboardFrame
      step="check"
      back="/onboarding/upload"
      asideLabel="Your master CV"
      aside={<CvSheet contained doc={cv.doc} legend marks={marks} />}
      footer={
        <>
          <Button block className={blocked ? s.blocked : undefined} busy={!blocked && updateProfile.isPending} disabled={blocked} onClick={next}>{ctaLabel}</Button>
          {blocked && (
            <Button variant="ghost" small data-quiet className={s.later} busy={updateProfile.isPending} onClick={next}>Fix later in Profile</Button>
          )}
        </>
      }
    >
      <div className={s.heading}>
        <h1 className={s.title}>{head.title}</h1>
        <p className={s.lede}>{head.lede}{desktop ? ' Your CV on the right updates as you go.' : ''}</p>
      </div>
      {error && <Notice tone="error">{error}</Notice>}

      {(issues.length > 0 || fixed.length > 0) && (
        <section aria-labelledby="fix-h" className={s.group}>
          <h2 id="fix-h" className={s.kicker}>Needs fixing</h2>
          {fixed.map((f, i) => (
            <div key={`${f.path}-${i}`} className={s.done} role="status">
              <Icon name="check" size={18} strokeWidth={2.4} className={s.doneIcon} />
              {f.text}
            </div>
          ))}
          {issues.map((issue) => (
            <IssueCard key={issue.path + issue.message} issue={issue} doc={cv.doc} onSave={(doc) => fix(issue, doc)} />
          ))}
        </section>
      )}

      {questions.length > 0 && (
        <section aria-labelledby="str-h" className={s.group}>
          <div className={s.kickerRow}>
            <h2 id="str-h" className={s.kicker}>Make it stronger</h2>
            <span className={s.count}>{current ? `${index + 1} of ${questions.length}, optional` : 'Done'}</span>
          </div>
          {current ? (
            <Question
              key={current.key}
              candidate={current}
              doc={cv.doc}
              onSave={async (doc) => { await save.mutateAsync(doc) }}
              onAdded={() => { setAdded((a) => [...a, current.key]); setIndex((i) => i + 1) }}
              onSkip={() => setIndex((i) => i + 1)}
            />
          ) : (
            <div className={s.finished} role="status">
              {added.length === 0
                ? 'Done. You can add numbers any time from Profile.'
                : desktop
                  ? 'Done. Your additions are marked on the CV and used in every tailored version.'
                  : `Done. ${added.length === 1 ? 'One bullet now carries a number' : `${added.length === 2 ? 'Two' : 'Three'} bullets now carry numbers`} we can use when we tailor.`}
            </div>
          )}
          <p className={s.note}>We never add numbers you did not give us. Anything you add here can be used in every tailored CV.</p>
        </section>
      )}

      <div className={s.phoneOnly}>
        <button type="button" className={s.textLink} aria-expanded={showCv} aria-controls="whole-cv" onClick={() => setShowCv((v) => !v)}>
          {showCv ? 'Hide your CV' : 'See your whole CV'}
        </button>
        {showCv && <div id="whole-cv" className={s.inlineCv}><CvSheet doc={cv.doc} legend marks={marks} /></div>}
      </div>

    </OnboardFrame>
  )
}

function Question({ candidate, doc, onSave, onAdded, onSkip }: {
  candidate: Candidate
  doc: ResumeDoc
  onSave: (doc: ResumeDoc) => Promise<void>
  onAdded: () => void
  onSkip: () => void
}) {
  const [answer, setAnswer] = useState('')
  const [edited, setEdited] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const merged = edited ?? mergeAnswer(candidate.text, answer)
  const showMerged = answer.trim().length > 0 || edited !== null

  async function add(e: FormEvent) {
    e.preventDefault()
    const text = merged.trim()
    if (!answer.trim() && edited === null) {
      setError('Type the number first, or choose I do not know.')
      return
    }
    if (!text) {
      setError('The bullet cannot be empty.')
      return
    }
    setError(null)
    setBusy(true)
    try {
      const experience = doc.experience.map((x, i) =>
        i === candidate.role ? { ...x, bullets: x.bullets.map((b, j) => (j === candidate.bullet ? text : b)) } : x)
      await onSave({ ...doc, experience })
      onAdded()
    } catch (err) {
      setError(toFormError(err).message)
      setBusy(false)
    }
  }

  return (
    <form className={s.question} onSubmit={add} noValidate aria-label="Add a number to a bullet">
      <div className={s.where}>{candidate.where}</div>
      <blockquote className={s.bullet}>{candidate.text}</blockquote>
      <TextField
        label="What number goes with this?"
        hint="A result, a size or a count, in your own words."
        placeholder="For example, cutting costs by 20%"
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        error={error}
      />
      {showMerged && (
        <TextArea
          label="Your bullet will read"
          rows={3}
          className={s.merged}
          value={merged}
          onChange={(e) => setEdited(e.target.value)}
          hint="Edit it if it reads better another way."
        />
      )}
      <div className={s.actions}>
        <Button type="submit" variant="dark" small busy={busy}>Add it</Button>
        <Button variant="ghost" small onClick={onSkip} disabled={busy}>I do not know</Button>
      </div>
    </form>
  )
}
