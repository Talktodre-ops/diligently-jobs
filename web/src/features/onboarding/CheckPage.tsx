import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Button, ButtonLink } from '../../ui/Button'
import { Icon } from '../../ui/Icon'
import { Notice } from '../../ui/Notice'
import { PageState } from '../../ui/PageState'
import { toFormError } from '../auth/errors'
import { useMaster, useSaveMaster, useUpdateProfile, type ResumeDoc } from './api'
import { IssueCard } from './components/IssueCards'
import { OnboardFrame } from './components/OnboardFrame'
import s from './CheckPage.module.css'

type Open = Record<'contact' | 'exp' | 'edu' | 'skills', boolean>

function Section({ id, title, meta, open, onToggle, children }: {
  id: string; title: string; meta: string; open: boolean; onToggle: () => void; children: React.ReactNode
}) {
  return (
    <section className={s.section}>
      <h2 className={s.sectionHead}>
        <button type="button" className={s.toggle} aria-expanded={open} aria-controls={id} onClick={onToggle}>
          <span className={s.sectionTitle}>{title}</span>
          <span className={s.meta}>{meta}</span>
          <Icon name="forward" size={18} strokeWidth={2} className={open ? s.chevOpen : s.chev} />
        </button>
      </h2>
      {open && <div id={id} className={s.sectionBody}>{children}</div>}
    </section>
  )
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`

function CvSections({ doc }: { doc: ResumeDoc }) {
  const [open, setOpen] = useState<Open>({ contact: false, exp: true, edu: false, skills: false })
  const toggle = (k: keyof Open) => () => setOpen((o) => ({ ...o, [k]: !o[k] }))
  const h = doc.header
  const contact = [h.email, h.phone, h.linkedin?.display, h.github?.display, h.website?.display].filter(Boolean) as string[]
  const skillCount = doc.skills.reduce((n, g) => n + g.items.length, 0)
  return (
    <>
      <Section id="sec-contact" title="Contact" meta={plural(contact.length + 1, 'item')} open={open.contact} onToggle={toggle('contact')}>
        <div className={s.line}><strong>{h.name}</strong>{h.title ? ` · ${h.title}` : ''}</div>
        <div className={s.sub}>{contact.join(' · ') || 'No contact details found'}</div>
      </Section>
      <Section id="sec-exp" title="Experience" meta={plural(doc.experience.length, 'role')} open={open.exp} onToggle={toggle('exp')}>
        {doc.experience.length === 0 && <div className={s.sub}>No roles found.</div>}
        {doc.experience.map((x, i) => {
          const missing = !x.start.trim() || !x.end.trim()
          return (
            <div key={i} className={s.row}>
              <div className={s.line}><strong>{x.company || 'Company missing'}</strong> · {x.role || 'Role missing'}</div>
              <div className={missing ? s.warn : s.sub}>
                {missing ? 'Dates missing' : `${x.start} to ${x.end}`} · {plural(x.bullets.length, 'bullet')}
              </div>
            </div>
          )
        })}
      </Section>
      <Section id="sec-edu" title="Education" meta={plural(doc.education.length, 'entry', 'entries')} open={open.edu} onToggle={toggle('edu')}>
        {doc.education.length === 0 && <div className={s.sub}>No education found. That is fine.</div>}
        {doc.education.map((x, i) => (
          <div key={i} className={s.row}>
            <div className={s.line}><strong>{x.institution}</strong></div>
            <div className={s.sub}>{[x.degree, [x.start, x.end].filter(Boolean).join(' to ')].filter(Boolean).join(' · ')}</div>
          </div>
        ))}
      </Section>
      <Section id="sec-skills" title="Skills" meta={plural(skillCount, 'skill')} open={open.skills} onToggle={toggle('skills')}>
        {skillCount === 0 && <div className={s.sub}>No skills found.</div>}
        <div className={s.chips}>
          {doc.skills.flatMap((g) => g.items).map((sk, i) => <span key={i} className={s.chip}>{sk}</span>)}
        </div>
      </Section>
    </>
  )
}

export default function CheckPage() {
  const navigate = useNavigate()
  const master = useMaster()
  const save = useSaveMaster()
  const updateProfile = useUpdateProfile()
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSave(doc: ResumeDoc) {
    setSaved(false)
    await save.mutateAsync(doc)
    setSaved(true)
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

  const cv = master.data
  return (
    <OnboardFrame
      step="check"
      back="/onboarding/upload"
      wide
      footer={cv ? <Button block busy={updateProfile.isPending} onClick={next}>Looks right</Button> : undefined}
    >
      <div className={s.heading}>
        <h1 className={s.title}>Check what we found</h1>
        <p className={s.lede}>Tap a section to look closer. Fix anything we got wrong.</p>
      </div>
      {master.isPending && <PageState.Loading />}
      {master.isError && <PageState.Error error={master.error} onRetry={() => master.refetch()} />}
      {master.isSuccess && !cv && (
        <PageState.Empty title="No CV yet" body="Upload your CV first so there is something to check." action={<ButtonLink to="/onboarding/upload">Upload a CV</ButtonLink>} />
      )}
      {cv && (
        <>
          {error && <Notice tone="error">{error}</Notice>}
          {cv.issues.map((issue) => (
            <IssueCard key={issue.path + issue.message} issue={issue} doc={cv.doc} onSave={onSave} />
          ))}
          {saved && cv.issues.length === 0 && <Notice tone="success">Saved. Everything checks out.</Notice>}
          <CvSections doc={cv.doc} />
        </>
      )}
    </OnboardFrame>
  )
}
