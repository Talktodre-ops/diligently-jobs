import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, isApiError } from '../../api/client'
import type { OnboardingStep, Profile } from '../../api/types'
import { profileKey } from '../../auth/session'

export type Link = { url: string; display: string }

export type ResumeDoc = {
  header: {
    name: string
    title: string
    email?: string | null
    phone?: string | null
    linkedin?: Link | null
    github?: Link | null
    website?: Link | null
  }
  summary?: string | null
  experience: { role: string; company: string; location?: string | null; start: string; end: string; bullets: string[] }[]
  education: { institution: string; location?: string | null; degree: string; start?: string | null; end?: string | null }[]
  skills: { label: string; items: string[] }[]
  projects: { name?: string | null; description: string; link?: Link | null }[]
}

export type Issue = { path: string; message: string }
export type MasterCv = { id: string; doc: ResumeDoc; issues: Issue[]; updated_at: string }

export type Upload = {
  id: string
  filename: string
  kind: 'pdf' | 'docx' | 'txt'
  status: 'queued' | 'reading' | 'done' | 'failed'
  error: string | null
  cv_version_id: string | null
}

export const masterKey = ['cv', 'master'] as const
const uploadKey = (id: string) => ['cv', 'upload', id] as const

export type FlowStep = Exclude<OnboardingStep, 'done'>
export const stepPath: Record<FlowStep, string> = {
  upload: '/onboarding/upload',
  check: '/onboarding/check',
  targets: '/onboarding/targets',
  first_job: '/onboarding/first-job',
}
export const stepOrder: OnboardingStep[] = ['upload', 'check', 'targets', 'first_job', 'done']

/** The master CV, or null when none exists yet (the API answers 422 no_master_cv). */
export function useMaster() {
  return useQuery({
    queryKey: masterKey,
    queryFn: async (): Promise<MasterCv | null> => {
      try {
        return (await api.get<{ cv: MasterCv }>('/v1/cv/master')).cv
      } catch (e) {
        if (isApiError(e, 'no_master_cv')) return null
        throw e
      }
    },
  })
}

export function useSaveMaster() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (doc: ResumeDoc) => (await api.put<{ cv: MasterCv }>('/v1/cv/master', { doc })).cv,
    onSuccess: (cv) => qc.setQueryData(masterKey, cv),
  })
}

export type ProfilePatch = Partial<Omit<Profile, 'updated_at' | 'notifications'>>

export function useUpdateProfile() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (patch: ProfilePatch) => (await api.patch<{ profile: Profile }>('/v1/profile', patch)).profile,
    onSuccess: (profile) => qc.setQueryData(profileKey, profile),
  })
}

/**
 * Marks onboarding finished. The caller writes the profile into the cache and
 * navigates in the same tick, so the onboarding frame never sees "done" while
 * it is still mounted (it would send the user Home instead).
 */
export function useFinishOnboarding() {
  return useMutation({
    mutationFn: async () => (await api.patch<{ profile: Profile }>('/v1/profile', { onboarding_step: 'done' })).profile,
  })
}

export function useStartUpload() {
  return useMutation({
    mutationFn: async (file: File) => {
      const body = new FormData()
      body.append('file', file)
      return api.post<{ upload: Upload; job_id: string }>('/v1/cv/upload', body)
    },
  })
}

/** Polls an upload every 1.5 s until it is done or failed. */
export function useUpload(id: string | null) {
  return useQuery({
    queryKey: uploadKey(id ?? 'none'),
    enabled: !!id,
    queryFn: async () => (await api.get<{ upload: Upload }>(`/v1/cv/uploads/${id}`)).upload,
    refetchInterval: (q) => (q.state.data && (q.state.data.status === 'done' || q.state.data.status === 'failed') ? false : 1500),
  })
}

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024
export const MIN_PASTE_CHARS = 200

/** Client-side file check that mirrors the API's rules. Returns a message, or null when fine. */
export function fileProblem(file: File): string | null {
  const ext = file.name.toLowerCase().split('.').pop()
  if (ext !== 'pdf' && ext !== 'docx') return 'Choose a PDF or Word (DOCX) file.'
  if (file.size === 0) return 'That file is empty.'
  if (file.size > MAX_UPLOAD_BYTES) return 'That file is over 5 MB.'
  return null
}

/** Pasted CV text goes up as a plain-text file, read by the same extraction as a PDF. */
export function pastedFile(text: string) {
  return new File([text.trim()], 'cv.txt', { type: 'text/plain' })
}

export function cvCounts(doc: ResumeDoc) {
  return {
    roles: doc.experience.length,
    bullets: doc.experience.reduce((n, e) => n + e.bullets.length, 0),
    skills: doc.skills.reduce((n, g) => n + g.items.length, 0),
  }
}
