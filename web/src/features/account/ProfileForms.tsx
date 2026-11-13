import { useState, type FormEvent } from 'react'
import { isApiError } from '../../api/client'
import type { Profile } from '../../api/types'
import { Button } from '../../ui/Button'
import { Notice } from '../../ui/Notice'
import { TextField } from '../../ui/TextField'
import { changedFields, useUpdateProfile, type ProfilePatch } from './api'
import s from './ProfilePage.module.css'

type Result = { error: unknown; saved: boolean }

function useSave() {
  const update = useUpdateProfile()
  const [saved, setSaved] = useState(false)
  const save = (patch: ProfilePatch, done: () => void) => {
    setSaved(false)
    if (Object.keys(patch).length === 0) { done(); return }
    update.mutate(patch, { onSuccess: () => { setSaved(true); done() } })
  }
  const result: Result = { error: update.error, saved }
  return { save, pending: update.isPending, result }
}

function FormNotice({ error, field }: { error: unknown; field?: string }) {
  if (!error) return null
  if (isApiError(error) && error.field && error.field === field) return null
  return <Notice tone="error">{isApiError(error) ? error.message : 'Could not save. Try again.'}</Notice>
}

/** Name, headline and location. Only the changed fields are sent. */
export function IdentityForm({ profile, onClose }: { profile: Profile; onClose: () => void }) {
  const base = { full_name: profile.full_name ?? '', headline: profile.headline ?? '', location: profile.location ?? '' }
  const [v, setV] = useState(base)
  const { save, pending, result } = useSave()
  const fieldError = (f: string) => (isApiError(result.error) && result.error.field === f ? result.error.message : null)
  const submit = (e: FormEvent) => { e.preventDefault(); save(changedFields(base, v), onClose) }
  return (
    <form className={s.form} onSubmit={submit}>
      <TextField label="Full name" value={v.full_name} autoComplete="name" onChange={(e) => setV({ ...v, full_name: e.target.value })} error={fieldError('full_name')} hint="Signs your follow-ups and cover letters." />
      <TextField label="Headline" value={v.headline} onChange={(e) => setV({ ...v, headline: e.target.value })} error={fieldError('headline')} />
      <TextField label="Location" value={v.location} onChange={(e) => setV({ ...v, location: e.target.value })} error={fieldError('location')} />
      <FormNotice error={result.error} />
      <div className={s.actions}>
        <Button type="submit" busy={pending}>Save</Button>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
      </div>
    </form>
  )
}

const WORK: { id: Profile['work_settings'][number]; label: string }[] = [
  { id: 'remote', label: 'Remote' },
  { id: 'hybrid', label: 'Hybrid' },
  { id: 'onsite', label: 'On site' },
]

export function splitRoles(text: string) {
  return text.split(/[,\n]/).map((x) => x.trim()).filter(Boolean)
}

/** Target roles and work settings. */
export function TargetsForm({ profile, onClose }: { profile: Profile; onClose: () => void }) {
  const base = { target_roles: profile.target_roles, work_settings: profile.work_settings }
  const [roles, setRoles] = useState(profile.target_roles.join(', '))
  const [work, setWork] = useState(profile.work_settings)
  const { save, pending, result } = useSave()
  const submit = (e: FormEvent) => {
    e.preventDefault()
    save(changedFields(base, { target_roles: splitRoles(roles), work_settings: work }), onClose)
  }
  const toggle = (id: Profile['work_settings'][number]) =>
    setWork((w) => (w.includes(id) ? w.filter((x) => x !== id) : [...w, id]))
  return (
    <form className={s.form} onSubmit={submit}>
      <TextField label="Roles you want" value={roles} onChange={(e) => setRoles(e.target.value)} hint="Separate roles with commas." error={isApiError(result.error) && result.error.field === 'target_roles' ? result.error.message : null} />
      <fieldset className={s.fieldset}>
        <legend>Where you want to work</legend>
        <div className={s.chips}>
          {WORK.map((w) => (
            <label key={w.id} className={s.chipLabel}>
              <input type="checkbox" checked={work.includes(w.id)} onChange={() => toggle(w.id)} />
              <span>{w.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <FormNotice error={result.error} field="target_roles" />
      <div className={s.actions}>
        <Button type="submit" busy={pending}>Save</Button>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
      </div>
    </form>
  )
}
