import { useState, type FormEvent, type ReactNode } from 'react'
import { Button } from '../../../ui/Button'
import { Notice } from '../../../ui/Notice'
import { TextArea, TextField } from '../../../ui/TextField'
import { toFormError } from '../../auth/errors'
import type { Issue, ResumeDoc } from '../api'
import s from './IssueCards.module.css'

type Props = { issue: Issue; doc: ResumeDoc; onSave: (doc: ResumeDoc) => Promise<unknown> }

const lines = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean)

/** One flagged problem with the inputs that fix it. Anything the API flags that we do not know how to edit shows as plain text. */
export function IssueCard({ issue, doc, onSave }: Props) {
  const path = issue.path
  const entry = path.match(/^experience\[(\d+)\](\.bullets)?$/)
  if (path === 'header.title') return <Headline issue={issue} doc={doc} onSave={onSave} />
  if (path === 'header.email') return <EmailFix issue={issue} doc={doc} onSave={onSave} />
  if (path === 'experience') return <AddRole issue={issue} doc={doc} onSave={onSave} />
  if (entry && entry[2]) return <Bullets issue={issue} doc={doc} onSave={onSave} index={Number(entry[1])} />
  if (entry) return <Dates issue={issue} doc={doc} onSave={onSave} index={Number(entry[1])} />
  if (path === 'skills') return <Skills issue={issue} doc={doc} onSave={onSave} />
  return (
    <Frame title={issue.message}>
      <p className={s.plain}>Fix this in Profile after setup.</p>
    </Frame>
  )
}

function Frame({ title, children, onSubmit, saveLabel, busy, error }: {
  title: string
  children: ReactNode
  onSubmit?: (e: FormEvent) => void
  saveLabel?: string
  busy?: boolean
  error?: string | null
}) {
  return (
    <section className={s.card} aria-label="Needs your input">
      <h2 className={s.title}>{title}</h2>
      {onSubmit ? (
        <form className={s.body} onSubmit={onSubmit} noValidate>
          {error && <Notice tone="error">{error}</Notice>}
          {children}
          <Button type="submit" variant="dark" small busy={busy} className={s.save}>{saveLabel}</Button>
        </form>
      ) : (
        children
      )}
    </section>
  )
}

/** Shared submit plumbing: build the next doc from the form, save it, show the API's message on failure. */
function useFix(onSave: Props['onSave']) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function run(build: () => ResumeDoc | string) {
    const next = build()
    if (typeof next === 'string') {
      setError(next)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onSave(next)
    } catch (e) {
      setError(toFormError(e).message)
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run }
}

type Sub = Props & { index?: number }

function Headline({ issue, doc, onSave }: Sub) {
  const [v, setV] = useState(doc.header.title)
  const fix = useFix(onSave)
  return (
    <Frame title={issue.message} saveLabel="Save headline" busy={fix.busy} error={fix.error}
      onSubmit={(e) => { e.preventDefault(); void fix.run(() => v.trim() ? { ...doc, header: { ...doc.header, title: v.trim() } } : 'Add a headline first.') }}>
      <TextField label="Headline" placeholder="Senior Backend Engineer" value={v} onChange={(e) => setV(e.target.value)} />
    </Frame>
  )
}

function EmailFix({ issue, doc, onSave }: Sub) {
  const [v, setV] = useState(doc.header.email ?? '')
  const fix = useFix(onSave)
  return (
    <Frame title={issue.message} saveLabel="Save email" busy={fix.busy} error={fix.error}
      onSubmit={(e) => { e.preventDefault(); void fix.run(() => v.trim() ? { ...doc, header: { ...doc.header, email: v.trim() } } : 'Add an email first.') }}>
      <TextField label="Email" type="email" value={v} onChange={(e) => setV(e.target.value)} />
    </Frame>
  )
}

function Dates({ issue, doc, onSave, index = 0 }: Sub) {
  const role = doc.experience[index]
  const [start, setStart] = useState(role?.start ?? '')
  const [end, setEnd] = useState(role?.end ?? '')
  const fix = useFix(onSave)
  const title = role?.company.trim() ? `When did you work at ${role.company.trim()}?` : issue.message
  return (
    <Frame title={title} saveLabel="Save dates" busy={fix.busy} error={fix.error}
      onSubmit={(e) => {
        e.preventDefault()
        void fix.run(() => {
          if (!start.trim() || !end.trim()) return 'Add both dates. Use "Present" for a current role.'
          const experience = doc.experience.map((x, i) => (i === index ? { ...x, start: start.trim(), end: end.trim() } : x))
          return { ...doc, experience }
        })
      }}>
      <div className={s.pair}>
        <TextField label="Started" placeholder="Jan 2016" value={start} onChange={(e) => setStart(e.target.value)} />
        <TextField label="Ended" placeholder="Jun 2018" value={end} onChange={(e) => setEnd(e.target.value)} />
      </div>
    </Frame>
  )
}

function Bullets({ issue, doc, onSave, index = 0 }: Sub) {
  const role = doc.experience[index]
  const [text, setText] = useState((role?.bullets ?? []).join('\n'))
  const fix = useFix(onSave)
  return (
    <Frame title={issue.message} saveLabel="Save" busy={fix.busy} error={fix.error}
      onSubmit={(e) => {
        e.preventDefault()
        void fix.run(() => {
          const bullets = lines(text)
          if (bullets.length === 0) return 'Add at least one line.'
          return { ...doc, experience: doc.experience.map((x, i) => (i === index ? { ...x, bullets } : x)) }
        })
      }}>
      <TextArea label="What you did" hint="One achievement per line." value={text} onChange={(e) => setText(e.target.value)} />
    </Frame>
  )
}

function AddRole({ issue, doc, onSave }: Sub) {
  const [f, setF] = useState({ role: '', company: '', start: '', end: '', bullets: '' })
  const fix = useFix(onSave)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }))
  return (
    <Frame title={issue.message} saveLabel="Add role" busy={fix.busy} error={fix.error}
      onSubmit={(e) => {
        e.preventDefault()
        void fix.run(() => {
          if (!f.role.trim() || !f.company.trim()) return 'Add a job title and a company.'
          const entry = { role: f.role.trim(), company: f.company.trim(), start: f.start.trim(), end: f.end.trim(), bullets: lines(f.bullets) }
          return { ...doc, experience: [...doc.experience, entry] }
        })
      }}>
      <div className={s.pair}>
        <TextField label="Job title" value={f.role} onChange={set('role')} />
        <TextField label="Company" value={f.company} onChange={set('company')} />
        <TextField label="Started" placeholder="Jan 2016" value={f.start} onChange={set('start')} />
        <TextField label="Ended" placeholder="Present" value={f.end} onChange={set('end')} />
      </div>
      <TextArea label="What you did" hint="One achievement per line." value={f.bullets} onChange={set('bullets')} />
    </Frame>
  )
}

function Skills({ issue, doc, onSave }: Sub) {
  const [text, setText] = useState('')
  const fix = useFix(onSave)
  return (
    <Frame title={issue.message} saveLabel="Save skills" busy={fix.busy} error={fix.error}
      onSubmit={(e) => {
        e.preventDefault()
        void fix.run(() => {
          const items = text.split(',').map((x) => x.trim()).filter(Boolean)
          if (items.length === 0) return 'Add at least one skill.'
          const keep = doc.skills.filter((g) => g.items.length > 0)
          return { ...doc, skills: [...keep, { label: 'Skills', items }] }
        })
      }}>
      <TextField label="Skills" hint="Separate them with commas." placeholder="Go, Postgres, Kafka" value={text} onChange={(e) => setText(e.target.value)} />
    </Frame>
  )
}
