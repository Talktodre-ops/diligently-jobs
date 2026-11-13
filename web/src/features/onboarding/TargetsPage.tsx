import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import type { Profile } from '../../api/types'
import { useProfile } from '../../auth/session'
import { Button } from '../../ui/Button'
import { Icon } from '../../ui/Icon'
import { Notice } from '../../ui/Notice'
import { TextField } from '../../ui/TextField'
import { toFormError } from '../auth/errors'
import { useMaster, useUpdateProfile } from './api'
import { OnboardFrame } from './components/OnboardFrame'
import s from './TargetsPage.module.css'

type Setting = Profile['work_settings'][number]
const SETTINGS: { value: Setting; label: string }[] = [
  { value: 'remote', label: 'Remote' },
  { value: 'hybrid', label: 'Hybrid' },
  { value: 'onsite', label: 'On-site' },
]
const PAPERS: { value: Profile['paper_size']; label: string; note: string }[] = [
  { value: 'a4', label: 'A4', note: 'Most of the world' },
  { value: 'letter', label: 'US Letter', note: 'US and Canada' },
]
const MAX_ROLES = 10

export default function TargetsPage() {
  return (
    <OnboardFrame step="targets" back="/onboarding/check">
      <TargetsForm />
    </OnboardFrame>
  )
}

function TargetsForm() {
  const navigate = useNavigate()
  const profile = useProfile()
  const master = useMaster()
  const update = useUpdateProfile()
  const p = profile.data
  const [roles, setRoles] = useState<string[]>(p?.target_roles ?? [])
  const [settings, setSettings] = useState<Setting[]>(p?.work_settings ?? [])
  const [location, setLocation] = useState(p?.location ?? '')
  const [paper, setPaper] = useState<Profile['paper_size']>(p?.paper_size ?? 'a4')
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [rolesError, setRolesError] = useState<string | null>(null)

  // Suggestions come from the CV the user just confirmed, not from a canned list.
  const doc = master.data?.doc
  const suggestions = [...new Set([doc?.header.title, ...(doc?.experience.map((x) => x.role) ?? [])].map((x) => x?.trim()).filter((x): x is string => !!x))]
    .filter((x) => !roles.some((r) => r.toLowerCase() === x.toLowerCase()))
    .slice(0, 5)

  function addRole(value: string) {
    const v = value.trim()
    if (!v) return
    if (roles.length >= MAX_ROLES) {
      setRolesError(`Choose at most ${MAX_ROLES} roles.`)
      return
    }
    if (!roles.some((r) => r.toLowerCase() === v.toLowerCase())) setRoles([...roles, v])
    setRolesError(null)
    setDraft('')
  }

  async function finish(e: FormEvent) {
    e.preventDefault()
    // A role typed but not added still counts.
    const pending = draft.trim()
    const finalRoles = pending && !roles.some((r) => r.toLowerCase() === pending.toLowerCase()) ? [...roles, pending] : roles
    if (finalRoles.length === 0) {
      setRolesError('Add at least one role you are looking for.')
      return
    }
    if (finalRoles.length > MAX_ROLES) {
      setRolesError(`Choose at most ${MAX_ROLES} roles.`)
      return
    }
    setError(null)
    try {
      await update.mutateAsync({
        target_roles: finalRoles,
        work_settings: settings,
        location: location.trim(),
        paper_size: paper,
        onboarding_step: 'done',
      })
      navigate('/', { replace: true })
    } catch (err) {
      const f = toFormError(err)
      if (f.field === 'target_roles') setRolesError(f.message)
      else setError(f.message)
    }
  }

  const toggle = (v: Setting) => setSettings((cur) => (cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]))

  return (
    <form className={s.form} onSubmit={finish} noValidate>
      <div className={s.heading}>
        <h1 className={s.title}>What are you looking for?</h1>
        <p className={s.lede}>This shapes how we tailor and what we flag. Change it any time.</p>
      </div>
      {error && <Notice tone="error">{error}</Notice>}

      <fieldset className={s.group}>
        <legend className={s.legend}>Roles <span className={s.legendNote}>· add up to {MAX_ROLES}</span></legend>
        {roles.length > 0 && (
          <ul className={s.chips} aria-label="Chosen roles">
            {roles.map((r) => (
              <li key={r} className={s.chosen}>
                {r}
                <button type="button" className={s.remove} aria-label={`Remove ${r}`} onClick={() => setRoles(roles.filter((x) => x !== r))}>
                  <Icon name="close" size={14} strokeWidth={2.2} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className={s.addRow}>
          <TextField
            label="Add a role"
            hideLabel
            placeholder="For example, Backend Engineer"
            value={draft}
            error={rolesError}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addRole(draft)
              }
            }}
          />
          <Button variant="quiet" onClick={() => addRole(draft)}>Add</Button>
        </div>
        {suggestions.length > 0 && (
          <div className={s.suggest}>
            <span className={s.suggestLabel}>From your CV</span>
            <div className={s.chips}>
              {suggestions.map((r) => (
                <button key={r} type="button" className={s.suggestion} onClick={() => addRole(r)}>+ {r}</button>
              ))}
            </div>
          </div>
        )}
      </fieldset>

      <fieldset className={s.group}>
        <legend className={s.legend}>Work setting</legend>
        <div className={s.three}>
          {SETTINGS.map((o) => (
            <button key={o.value} type="button" aria-pressed={settings.includes(o.value)} className={s.pick} onClick={() => toggle(o.value)}>
              {o.label}
            </button>
          ))}
        </div>
      </fieldset>

      <TextField label="Where you are" autoComplete="address-level2" placeholder="City, Country" value={location} onChange={(e) => setLocation(e.target.value)} />

      <fieldset className={s.group}>
        <legend className={s.legend}>Paper size for your CV</legend>
        <div className={s.two}>
          {PAPERS.map((o) => (
            <button key={o.value} type="button" aria-pressed={paper === o.value} className={`${s.pick} ${s.paper}`} onClick={() => setPaper(o.value)}>
              <span className={s.paperName}>{o.label}</span>
              <span className={s.paperNote}>{o.note}</span>
            </button>
          ))}
        </div>
      </fieldset>

      <div className={s.submit}>
        <Button type="submit" block busy={update.isPending}>Finish setup</Button>
      </div>
    </form>
  )
}
