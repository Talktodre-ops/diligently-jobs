// Types and hooks for Research, Cover letter, CV preview, Send and Documents.
// Shapes follow docs/api.md and backend/src/routes/{research,cover_letters,files,tracking}.rs.
// The brief, rewrites, gaps and tailored CV come from the apply feature so the
// whole app shares one cache entry for each.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, isApiError } from '../../api/client'
import type { Job } from '../../api/types'
import { keys as applyKeys } from '../apply/api'

export type Cited = { text: string; source: number }
export type ResearchBrief = {
  overview: string | null
  products: string[]
  recent_news: Cited[]
  culture: string[]
  talking_points: Cited[]
  why_them: string | null
}
export type Source = { title: string; url: string; snippet?: string | null; published?: string | null }
export type Research = { id: string; application_id: string; brief: ResearchBrief; sources: Source[]; created_at: string }

export const TONES = ['direct', 'warm', 'formal'] as const
export type Tone = (typeof TONES)[number]
export type LetterDoc = {
  candidate_name: string
  candidate_contact?: string | null
  date?: string | null
  company?: string | null
  greeting?: string | null
  paragraphs: string[]
  signoff?: string | null
}
export type Letter = {
  id: string
  application_id: string
  body: string
  doc: LetterDoc | null
  tone: string
  r2_pdf_key: string | null
  r2_docx_key: string | null
  generated_at: string
}

export type FileLinks = {
  cv: { pdf_url: string | null; docx_url: string | null; rendered_at: string | null; up_to_date: boolean }
  letter: { pdf_url: string | null; docx_url: string | null }
  expires_in_seconds: number
}
export type RenderStarted = { cv_version_id: string; cv_job_id: string; letter_job_id: string | null }

export type CvDocument = {
  kind: 'cv'
  application_id: string
  company: string | null
  role: string | null
  score: number | null
  formats: ('pdf' | 'docx')[]
  updated_at: string
}
export type LetterDocument = {
  kind: 'letter'
  id: string
  application_id: string
  company: string | null
  tone: string
  words: number
  updated_at: string
}
export type DocumentItem = CvDocument | LetterDocument
export type DocumentKind = 'all' | 'cv' | 'letter'

export type Reminder = { id: string; application_id: string; due_at: string; status: string; sent_at: string | null }
export type Applied = { application_id: string; stage: string; reminder: Reminder | null }

export const docKeys = {
  research: (id: string) => ['application', id, 'research'] as const,
  letter: (id: string) => ['application', id, 'letter'] as const,
  files: (id: string) => ['application', id, 'files'] as const,
  documents: (kind: DocumentKind) => ['documents', kind] as const,
}

/** A 404 here means "not made yet"; the brief query tells a missing application apart. */
async function orNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p
  } catch (e) {
    if (isApiError(e, 'not_found')) return null
    throw e
  }
}

export function useResearch(id: string) {
  return useQuery({
    queryKey: docKeys.research(id),
    queryFn: () => orNull(api.get<Research>(`/v1/applications/${id}/research`)),
  })
}

export function useRefreshResearch(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.post<Research>(`/v1/applications/${id}/research/refresh`),
    onSuccess: (research) => {
      qc.setQueryData(docKeys.research(id), research)
      qc.invalidateQueries({ queryKey: applyKeys.brief(id) })
    },
  })
}

export function useLetter(id: string) {
  return useQuery({
    queryKey: docKeys.letter(id),
    queryFn: () => orNull(api.get<Letter>(`/v1/applications/${id}/cover-letters`)),
  })
}

/** The letter's body paragraphs, from the doc when it has one. */
export function letterParagraphs(letter: Letter): string[] {
  if (letter.doc?.paragraphs?.length) return letter.doc.paragraphs
  return letter.body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
}

function letterChanged(qc: ReturnType<typeof useQueryClient>, id: string, letter: Letter) {
  qc.setQueryData(docKeys.letter(id), letter)
  qc.invalidateQueries({ queryKey: applyKeys.brief(id) })
  qc.invalidateQueries({ queryKey: docKeys.files(id) })
  qc.invalidateQueries({ queryKey: ['documents'] })
}

/** Writes a new letter in `tone`. It becomes the application's letter. */
export function useRegenerateLetter(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (tone: Tone) => api.post<Letter>(`/v1/applications/${id}/cover-letters/regenerate`, { tone }),
    onSuccess: (letter) => letterChanged(qc, id, letter),
  })
}

export function useEditLetter(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ letterId, paragraphs }: { letterId: string; paragraphs: string[] }) =>
      api.patch<Letter>(`/v1/cover-letters/${letterId}`, { paragraphs }),
    onSuccess: (letter) => letterChanged(qc, id, letter),
  })
}

export const filesPath = (id: string) => `/v1/applications/${id}/files`

/** Download links. They last ten minutes, so anything that hands one to the
 *  browser fetches a fresh set first (see useFreshFiles). */
export function useFiles(id: string) {
  return useQuery({
    queryKey: docKeys.files(id),
    queryFn: () => api.get<FileLinks>(filesPath(id)),
    staleTime: 5 * 60_000,
  })
}

/** Returns a function that fetches links signed just now. */
export function useFreshFiles() {
  const qc = useQueryClient()
  return (id: string) => qc.fetchQuery({ queryKey: docKeys.files(id), queryFn: () => api.get<FileLinks>(filesPath(id)), staleTime: 0 })
}

export function startRender(id: string, includeLetter: boolean) {
  return api.post<RenderStarted>(`/v1/applications/${id}/render`, { include_letter: includeLetter })
}

/** Polls one background job until it is done or failed. */
export async function waitForJob(jobId: string, intervalMs = 1500, timeoutMs = 120_000): Promise<Job> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const job = await api.get<Job>(`/v1/jobs/${jobId}`)
    if (job.status === 'done' || job.status === 'failed') return job
    if (Date.now() > deadline) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

export function useDocuments(kind: DocumentKind) {
  return useQuery({
    queryKey: docKeys.documents(kind),
    queryFn: () => api.get<{ documents: DocumentItem[] }>(`/v1/documents?kind=${kind}`),
  })
}

export function useMarkApplied(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (reminderDays: number | null) => api.post<Applied>(`/v1/applications/${id}/applied`, { reminder_days: reminderDays }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['home'] })
      qc.invalidateQueries({ queryKey: ['applications'] })
      qc.invalidateQueries({ queryKey: applyKeys.brief(id) })
    },
  })
}

/** Moves the follow-up reminder to `days` from now (used to change 7 to 5 or 10). */
export function useMoveReminder() {
  return useMutation({
    mutationFn: ({ reminderId, days }: { reminderId: string; days: number }) =>
      api.post<{ reminder: Reminder }>(`/v1/reminders/${reminderId}/snooze`, { days }),
  })
}
