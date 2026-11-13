import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, isApiError } from '../../api/client'
import type { Profile } from '../../api/types'
import { profileKey } from '../../auth/session'

export type ProfilePatch = Partial<Omit<Profile, 'updated_at' | 'onboarding_step' | 'notifications'>> & {
  notifications?: Partial<Profile['notifications']>
}

/** PATCH /v1/profile with only the fields that changed. */
export function useUpdateProfile() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (patch: ProfilePatch) => api.patch<{ profile: Profile }>('/v1/profile', patch),
    onSuccess: ({ profile }) => qc.setQueryData(profileKey, profile),
  })
}

/** Keys of `next` whose value differs from `base`. */
export function changedFields<T extends object>(base: T, next: T): Partial<T> {
  const out: Partial<T> = {}
  for (const k of Object.keys(next) as (keyof T)[]) {
    if (JSON.stringify(base[k]) !== JSON.stringify(next[k])) out[k] = next[k]
  }
  return out
}

export type ResumeDoc = {
  header: { name?: string | null; title?: string | null; email?: string | null; phone?: string | null }
  summary?: string | null
  experience: { role: string; company: string; start?: string | null; end?: string | null }[]
  education: { institution: string; degree?: string | null }[]
  skills: { label: string; items: string[] }[]
  projects: { name?: string | null; description?: string | null }[]
}
export type MasterCv = { id: string; doc: ResumeDoc; issues: { path: string; message: string }[]; updated_at: string }

export const masterKey = ['master-cv'] as const

export function useMasterCv() {
  return useQuery({
    queryKey: masterKey,
    queryFn: async () => {
      try {
        return (await api.get<{ cv: MasterCv }>('/v1/cv/master')).cv
      } catch (e) {
        if (isApiError(e, 'no_master_cv')) return null
        throw e
      }
    },
  })
}

export type Upload = { id: string; filename: string; status: 'queued' | 'reading' | 'done' | 'failed'; error: string | null }

export function useStartUpload() {
  return useMutation({
    mutationFn: (file: File) => {
      const form = new FormData()
      form.append('file', file)
      return api.post<{ upload: Upload; job_id: string }>('/v1/cv/upload', form)
    },
  })
}

/** Polls the upload every 1.5 s until it is done or failed. */
export function useUploadStatus(id: string | null) {
  const qc = useQueryClient()
  return useQuery({
    queryKey: ['upload', id],
    enabled: !!id,
    queryFn: async () => {
      const { upload } = await api.get<{ upload: Upload }>(`/v1/cv/uploads/${id}`)
      if (upload.status === 'done') void qc.invalidateQueries({ queryKey: masterKey })
      return upload
    },
    refetchInterval: (q) => (q.state.data && (q.state.data.status === 'done' || q.state.data.status === 'failed') ? false : 1500),
  })
}

export type SessionRow = { id: string; user_agent: string | null; ip: string | null; created_at: string; last_seen_at: string; current: boolean }
export const sessionsKey = ['sessions'] as const

export function useSessions() {
  return useQuery({ queryKey: sessionsKey, queryFn: async () => (await api.get<{ sessions: SessionRow[] }>('/v1/auth/sessions')).sessions })
}

export function useRevokeSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.del(`/v1/auth/sessions/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: sessionsKey }),
  })
}

export function useRevokeOthers() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.post<{ revoked: number }>('/v1/auth/sessions/revoke-others'),
    onSuccess: () => qc.invalidateQueries({ queryKey: sessionsKey }),
  })
}

export function useChangePassword() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (b: { current_password: string; new_password: string }) => api.post<{ ok: true }>('/v1/auth/change-password', b),
    onSuccess: () => qc.invalidateQueries({ queryKey: sessionsKey }),
  })
}

export function useChangeEmail() {
  return useMutation({ mutationFn: (b: { new_email: string; password: string }) => api.post<void>('/v1/auth/change-email', b) })
}

export function useSignOut() {
  return useMutation({ mutationFn: () => api.post<void>('/v1/auth/signout') })
}

/** DELETE with a JSON body: api.del sends none, so this calls fetch itself. */
export async function deleteAccount(password: string): Promise<void> {
  let res: Response
  try {
    res = await fetch('/v1/account', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ password }),
      credentials: 'same-origin',
    })
  } catch {
    throw new ApiError(0, 'network', 'You appear to be offline. Check your connection and try again.', null, null)
  }
  if (res.ok) return
  let err: { code?: string; message?: string; field?: string | null } | undefined
  try {
    err = ((await res.json()) as { error?: typeof err }).error
  } catch {
    err = undefined
  }
  throw new ApiError(res.status, err?.code ?? `http_${res.status}`, err?.message ?? 'Could not delete the account. Try again.', err?.field ?? null, null)
}

/** GET /v1/account/export and hand the JSON to the browser as a download. */
export async function downloadExport(): Promise<string> {
  let res: Response
  try {
    res = await fetch('/v1/account/export', { credentials: 'same-origin' })
  } catch {
    throw new ApiError(0, 'network', 'You appear to be offline. Check your connection and try again.', null, null)
  }
  if (!res.ok) {
    let msg = 'Could not prepare your data. Try again.'
    try {
      msg = ((await res.json()) as { error?: { message?: string } }).error?.message ?? msg
    } catch {
      /* keep the default message */
    }
    throw new ApiError(res.status, `http_${res.status}`, msg, null, res.headers.get('Retry-After') ? Number(res.headers.get('Retry-After')) : null)
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'diligently-export.json'
  const url = URL.createObjectURL(await res.blob())
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return name
}
