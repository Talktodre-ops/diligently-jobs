import { useState, type FormEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import type { Profile } from '../../api/types'
import { useProfile } from '../../auth/session'
import { Button } from '../../ui/Button'
import { Notice } from '../../ui/Notice'
import { PageState } from '../../ui/PageState'
import { TextField } from '../../ui/TextField'
import { toFormError } from '../auth/errors'
import { useMaster, useUpdateProfile, type ResumeDoc } from './api'
import { CvSheet } from './components/CvSheet'
import { OnboardFrame } from './components/OnboardFrame'
import { countryOf, inferPaper } from './cvFacts'
import s from './TargetsPage.module.css'

type Setting = Profile['work_settings'][number]
const SETTINGS: { value: Setting; label: string }[] = [
  { value: 'remote', label: 'Remote' },
  { value: 'hybrid', label: 'Hybrid' },
  { value: 'onsite', label: 'On-site' },
]
const MAX_ROLES = 10
const MAX_PLACES = 10
const REMOTE_ANYWHERE = 'Remote anywhere'

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
const has = (list: string[], v: string) => list.some((x) => same(x, v))
const uniq = (list: (string | null | undefined)[]) =>
  list.map((x) => x?.trim() ?? '').filter(Boolean).reduce<string[]>((out, x) => (has(out, x) ? out : [...out, x]), [])

/** Role titles from the CV: the headline first, then each role, most recent first. */
function suggestedRoles(doc: ResumeDoc | undefined) {
  return uniq([doc?.header.title, ...(doc?.experience.map((e) => e.role) ?? [])]).slice(0, 6)
}

export default function TargetsPage() {
  const profile = useProfile()
  const master = useMaster()
  // The form starts from the saved profile and the CV, so wait for both.
  if (profile.isPending || master.isPending || !profile.data) {
    return (
      <OnboardFrame step="targets" back="/onboarding/check">
        <PageState.Loading />
      </OnboardFrame>
    )
  }
  return <TargetsForm profile={profile.data} doc={master.data?.doc} />
}

function Chip({ on, onClick, children, className }: { on: boolean; onClick: () => void; children: ReactNode; className?: string }) {
  return (
    <button type="button" aria-pressed={on} className={[s.chip, className].filter(Boolean).join(' ')} onClick={onClick}>
      {children}
    </button>
  )
}

/** A "+ Another" chip that opens a small input to add your own. */
function AddOwn({ label, field, placeholder, onAdd }: { label: string; field: string; placeholder: string; onAdd: (v: string) => string | null }) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  function add() {
    const problem = onAdd(value)
    if (problem) return setError(problem)
    setValue('')
    setError(null)
    setOpen(false)
  }
  if (!open) return <button type="button" className={`${s.chip} ${s.another}`} onClick={() => setOpen(true)}>+ {label}</button>
  return (
    <div className={s.addRow}>
      <TextField
        label={field}
        hideLabel
        autoFocus
        placeholder={placeholder}
        value={value}
        error={error}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            add()
          }
          if (e.key === 'Escape') setOpen(false)
        }}
      />
      <Button variant="quiet" onClick={add}>Add</Button>
    </div>
  )
}

function TargetsForm({ profile, doc }: { profile: Profile; doc: ResumeDoc | undefined }) {
  const navigate = useNavigate()
  const update = useUpdateProfile()
  const fromCv = suggestedRoles(doc)
  const [roleOptions, setRoleOptions] = useState(() => uniq([...profile.target_roles, ...fromCv]))
  // "We picked these from your CV": the headline and the latest role start selected.
  const [roles, setRoles] = useState<string[]>(() => (profile.target_roles.length ? profile.target_roles : fromCv.slice(0, 2)))
  const [settings, setSettings] = useState<Setting[]>(profile.work_settings)
  const [location, setLocation] = useState(profile.location ?? '')
  const [editLocation, setEditLocation] = useState(!profile.location)
  const [openTo, setOpenTo] = useState<string[]>(profile.open_to ?? [])
  const [extraPlaces, setExtraPlaces] = useState<string[]>(() => (profile.open_to ?? []).filter((p) => !same(p, REMOTE_ANYWHERE)))
  const [paperChoice, setPaperChoice] = useState<Profile['paper_size'] | null>(null)
  const [errors, setErrors] = useState<{ roles?: string; settings?: string; openTo?: string; location?: string; form?: string }>({})

  const country = countryOf(location)
  const placeOptions = uniq([REMOTE_ANYWHERE, country, ...extraPlaces])
  const inferred = inferPaper(location)
  const paper = paperChoice ?? inferred

  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v])

  function toggleRole(r: string) {
    if (!has(roles, r) && roles.length >= MAX_ROLES) return setErrors((e) => ({ ...e, roles: `Choose at most ${MAX_ROLES} roles.` }))
    setErrors((e) => ({ ...e, roles: undefined }))
    setRoles(has(roles, r) ? roles.filter((x) => !same(x, r)) : [...roles, r])
  }

  function addRole(v: string): string | null {
    const r = v.trim()
    if (!r) return 'Type a role first.'
    if (r.length > 80) return 'Keep it under 80 characters.'
    if (!has(roles, r) && roles.length >= MAX_ROLES) return `Choose at most ${MAX_ROLES} roles.`
    if (!has(roleOptions, r)) setRoleOptions([...roleOptions, r])
    if (!has(roles, r)) setRoles([...roles, r])
    setErrors((e) => ({ ...e, roles: undefined }))
    return null
  }

  function togglePlace(p: string) {
    if (!has(openTo, p) && openTo.length >= MAX_PLACES) return setErrors((e) => ({ ...e, openTo: `Choose at most ${MAX_PLACES} places.` }))
    setErrors((e) => ({ ...e, openTo: undefined }))
    setOpenTo(has(openTo, p) ? openTo.filter((x) => !same(x, p)) : [...openTo, p])
  }

  function addPlace(v: string): string | null {
    const p = v.trim()
    if (!p) return 'Type a place first.'
    if (p.length > 80) return 'Keep it under 80 characters.'
    if (!has(openTo, p) && openTo.length >= MAX_PLACES) return `Choose at most ${MAX_PLACES} places.`
    if (!has(placeOptions, p)) setExtraPlaces([...extraPlaces, p])
    if (!has(openTo, p)) setOpenTo([...openTo, p])
    return null
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    const next: typeof errors = {}
    if (roles.length === 0) next.roles = 'Choose at least one role.'
    if (settings.length === 0) next.settings = 'Choose at least one.'
    setErrors(next)
    if (next.roles || next.settings) return
    try {
      await update.mutateAsync({
        target_roles: roles,
        work_settings: settings,
        location: location.trim(),
        // Only places still on offer: a country chip goes away when the location changes.
        open_to: openTo.filter((p) => has(placeOptions, p)),
        paper_size: paper,
        onboarding_step: 'first_job',
      })
      navigate('/onboarding/first-job')
    } catch (err) {
      const f = toFormError(err)
      const key = f.field === 'target_roles' ? 'roles' : f.field === 'work_settings' ? 'settings' : f.field === 'open_to' ? 'openTo' : f.field === 'location' ? 'location' : 'form'
      setErrors({ [key]: f.message })
    }
  }

  const placesLine = openTo.filter((p) => has(placeOptions, p))
  const openLine = placesLine.length === 0
    ? ''
    : has(placesLine, REMOTE_ANYWHERE) && placesLine.length === 1
      ? ' Open to remote roles anywhere.'
      : ` Open to ${placesLine.map((p) => (same(p, REMOTE_ANYWHERE) ? 'remote roles anywhere' : p)).join(', ')}.`

  return (
    <OnboardFrame
      step="targets"
      back="/onboarding/check"
      aside={doc ? <CvSheet contained doc={doc} /> : undefined}
      footer={<Button type="submit" form="targets" block busy={update.isPending}>Continue</Button>}
    >
      <form id="targets" className={s.form} onSubmit={submit} noValidate>
        <div className={s.heading}>
          <h1 className={s.title}>What are you going for?</h1>
          <p className={s.lede}>{fromCv.length ? 'We picked these from your CV. Tap to change.' : 'Pick the roles you want. Tap to change.'}</p>
        </div>
        {errors.form && <Notice tone="error">{errors.form}</Notice>}

        <fieldset className={s.group} aria-describedby={errors.roles ? 'roles-err' : undefined}>
          <legend className={s.legend}>Roles</legend>
          <div className={s.chips}>
            {roleOptions.map((r) => <Chip key={r} on={has(roles, r)} onClick={() => toggleRole(r)}>{r}</Chip>)}
            <AddOwn label="Another" field="Another role" placeholder="For example, Platform Engineer" onAdd={addRole} />
          </div>
          {errors.roles && <p id="roles-err" className={s.error} role="alert">{errors.roles}</p>}
        </fieldset>

        <fieldset className={s.group} aria-describedby={errors.settings ? 'settings-err' : undefined}>
          <legend className={s.legend}>Where you can work</legend>
          <div className={s.three}>
            {SETTINGS.map((o) => (
              <Chip key={o.value} className={s.block} on={settings.includes(o.value)} onClick={() => { setSettings(toggle(settings, o.value)); setErrors((e) => ({ ...e, settings: undefined })) }}>
                {o.label}
              </Chip>
            ))}
          </div>
          {errors.settings && <p id="settings-err" className={s.error} role="alert">{errors.settings}</p>}

          {editLocation ? (
            <div className={s.locationEdit}>
              <TextField
                label="Where you are based"
                autoComplete="address-level2"
                placeholder="City, Country"
                value={location}
                error={errors.location}
                onChange={(e) => setLocation(e.target.value)}
              />
              {location.trim() && <Button variant="quiet" small onClick={() => setEditLocation(false)}>Done</Button>}
            </div>
          ) : (
            <div className={s.location}>
              <span className={s.locationText}>Based in <strong>{location}</strong>.{openLine}</span>
              <button type="button" className={s.textButton} onClick={() => setEditLocation(true)}>
                Change<span className="visually-hidden"> where you are based</span>
              </button>
            </div>
          )}
        </fieldset>

        <fieldset className={s.group} aria-describedby={errors.openTo ? 'open-err' : undefined}>
          <legend className={s.legend}>Open to</legend>
          <p className={s.help}>Optional. Places you would work from or move to.</p>
          <div className={s.chips}>
            {placeOptions.map((p) => <Chip key={p} on={has(openTo, p)} onClick={() => togglePlace(p)}>{p}</Chip>)}
            <AddOwn label="Another place" field="Another place" placeholder="For example, Canada" onAdd={addPlace} />
          </div>
          {errors.openTo && <p id="open-err" className={s.error} role="alert">{errors.openTo}</p>}
        </fieldset>

        <p className={s.paper}>
          {paper === 'a4' ? 'CVs print on A4' : 'CVs print on US Letter'}
          {paper === inferred && country ? `, the standard in ${country}.` : '.'}{' '}
          <button type="button" className={s.textButton} onClick={() => setPaperChoice(paper === 'a4' ? 'letter' : 'a4')}>
            {paper === 'a4' ? 'Use US Letter' : 'Use A4'}
          </button>
        </p>
      </form>
    </OnboardFrame>
  )
}
