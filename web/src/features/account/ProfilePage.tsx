import { useState } from 'react'
import { Link } from 'react-router'
import { useProfile } from '../../auth/session'
import { Button } from '../../ui/Button'
import { Icon } from '../../ui/Icon'
import { PageState } from '../../ui/PageState'
import { useMasterCv, type ResumeDoc } from './api'
import { MasterCvCard } from './MasterCvCard'
import { IdentityForm, TargetsForm } from './ProfileForms'
import s from './ProfilePage.module.css'

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?'

function sections(doc: ResumeDoc) {
  const when = (a?: string | null, b?: string | null) => [a, b].filter(Boolean).join(' to ')
  const skillCount = doc.skills.reduce((n, g) => n + g.items.length, 0)
  const contact = [doc.header.email, doc.header.phone].filter(Boolean) as string[]
  return [
    { label: 'Experience', count: `${doc.experience.length} role${doc.experience.length === 1 ? '' : 's'}`, items: doc.experience.map((e) => [e.company, e.role, when(e.start, e.end)].filter(Boolean).join(' · ')) },
    { label: 'Education', count: String(doc.education.length), items: doc.education.map((e) => [e.institution, e.degree].filter(Boolean).join(' · ')) },
    { label: 'Skills', count: String(skillCount), items: doc.skills.map((g) => `${g.label}: ${g.items.join(', ')}`) },
    { label: 'Projects', count: String(doc.projects.length), items: doc.projects.map((p) => p.name || p.description || '') },
    { label: 'Contact', count: String(contact.length), items: contact },
  ]
}

const WORK_WORDS = { remote: 'Remote', hybrid: 'Hybrid', onsite: 'On site' } as const

export default function ProfilePage() {
  const profile = useProfile()
  const cv = useMasterCv()
  const [open, setOpen] = useState<string | null>('Experience')
  const [editing, setEditing] = useState<'identity' | 'targets' | null>(null)

  if (profile.isPending) return <PageState.Loading />
  if (profile.isError) return <PageState.Error error={profile.error} onRetry={() => profile.refetch()} />
  const p = profile.data
  const name = p.full_name || cv.data?.doc.header.name || 'Your name'
  const sub = [p.headline, p.location].filter(Boolean).join(' · ')

  return (
    <div className={s.page}>
      <header className={s.head}>
        <h1>Profile</h1>
        <Link to="/settings" className={s.gear} aria-label="Settings"><Icon name="settings" size={22} /></Link>
      </header>

      <div className={s.grid}>
        <div className={s.col}>
          <section className={s.card} aria-label="About you">
            {editing === 'identity' ? (
              <IdentityForm profile={p} onClose={() => setEditing(null)} />
            ) : (
              <div className={s.identity}>
                <div className={s.avatar} aria-hidden="true">{initials(name)}</div>
                <div className={s.idText}>
                  <div className={s.name}>{name}</div>
                  <div className={s.muted}>{sub || 'Add a headline and location'}</div>
                </div>
                <Button variant="ghost" small onClick={() => setEditing('identity')} aria-label="Edit your details"><Icon name="edit" size={16} />Edit</Button>
              </div>
            )}
          </section>

          <section className={s.card} aria-label="What you are looking for">
            <div className={s.cardHead}>
              <h2 className={s.cardTitle}>Looking for</h2>
              {editing !== 'targets' && <Button variant="ghost" small onClick={() => setEditing('targets')} aria-label="Edit what you are looking for">Edit</Button>}
            </div>
            {editing === 'targets' ? (
              <TargetsForm profile={p} onClose={() => setEditing(null)} />
            ) : (
              <div className={s.chips}>
                {p.target_roles.length === 0 && p.work_settings.length === 0 && <span className={s.muted}>Nothing set yet.</span>}
                {p.target_roles.map((r) => <span key={r} className={s.chip}>{r}</span>)}
                {p.work_settings.map((w) => <span key={w} className={s.chip}>{WORK_WORDS[w]}</span>)}
                <span className={s.chip}>{p.paper_size === 'a4' ? 'A4' : 'US Letter'}</span>
              </div>
            )}
          </section>
        </div>

        <div className={s.col}>
          <MasterCvCard />
          {cv.isError && <PageState.Error error={cv.error} onRetry={() => cv.refetch()} />}
          {cv.data && (
            <section className={s.card} aria-label="Sections">
              {sections(cv.data.doc).map((sec) => (
                <div key={sec.label} className={s.acc}>
                  <button type="button" className={s.accBtn} aria-expanded={open === sec.label} onClick={() => setOpen(open === sec.label ? null : sec.label)}>
                    <span className={s.accLabel}>{sec.label}</span>
                    <span className={s.muted}>{sec.count}</span>
                    <Icon name="forward" size={18} className={open === sec.label ? s.rotOpen : s.rot} />
                  </button>
                  {open === sec.label && (
                    <ul className={s.accList}>
                      {sec.items.length === 0 ? <li className={s.muted}>Nothing found.</li> : sec.items.map((it, i) => <li key={i}>{it}</li>)}
                    </ul>
                  )}
                </div>
              ))}
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
