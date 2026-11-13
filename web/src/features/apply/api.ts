// Types and hooks for the apply flow: New job, Running, Workspace, Review,
// Gaps. Shapes follow docs/api.md and backend/src/routes/{workspace,review,gaps}.rs.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api/client'
import type { Job } from '../../api/types'

export type StepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed'
export type Step = { key: string; label: string; status: StepStatus }
export type PipelineJob = Omit<Job, 'progress'> & { progress: Step[] | null }

export type Score = {
  before: number | null
  projected: number | null
  current: number | null
  rescored: number | null
  decided: number
  pending: number
}

export type Brief = {
  application: {
    id: string
    company: string | null
    role: string | null
    status: string
    source_url: string | null
    location: string | null
    summary: string | null
    created_at: string
  }
  pipeline: { job_id: string; status: Job['status']; progress: Step[] | null } | null
  score: Score
  rewrites: { total: number; pending: number; accepted: number; kept: number; edited: number }
  summary: { proposed: boolean; status: string }
  gaps: { total: number; missing: number; partial: number; unanswered: number; top: string[] }
  research: { overview: string | null; talking_points: number | null } | null
  letter: { id: string; tone: string; words: number | null } | null
}

export type RewriteStatus = 'pending' | 'accepted' | 'kept' | 'edited'
export type Rewrite = {
  id: string
  bullet_id: string | null
  section: string
  original: string
  rewrite: string
  why: string | null
  needs_number: boolean
  status: RewriteStatus
  final_text: string | null
}
export type SummaryProposal = { original: string | null; proposed: string; status: string }
export type Rewrites = { summary: SummaryProposal | null; rewrites: Rewrite[]; score: Score }
export type Decision = { action: 'accept' } | { action: 'keep' } | { action: 'edit'; text: string }

export type Gap = {
  id: string
  application_id: string
  requirement: string
  importance: 'required' | 'nice_to_have' | string
  status: 'covered' | 'partial' | 'missing'
  evidence: string | null
  ask: string | null
  answer: 'have' | 'dont' | null
  answer_text: string | null
  suggested_bullet: string | null
  bullet_status: 'pending' | 'accepted' | 'discarded' | null
  target_entry: number | null
}

export type ResumeDoc = {
  header: {
    name: string
    title?: string | null
    email?: string | null
    phone?: string | null
    linkedin?: { url: string; display: string } | null
    github?: { url: string; display: string } | null
    website?: { url: string; display: string } | null
  }
  summary?: string | null
  experience: { role: string; company: string; location?: string | null; start?: string | null; end?: string | null; bullets: string[] }[]
  education: { institution: string; location?: string | null; degree?: string | null; start?: string | null; end?: string | null }[]
  skills: { label: string; items: string[] }[]
  projects?: { name?: string | null; description: string; link?: string | null }[]
}
export type TailoredCv = { doc: ResumeDoc; issues: { path: string; message: string }[]; paper_size: 'a4' | 'letter' }

export type StartInput = { jd_text: string; research: boolean; letter: boolean } | { url: string; research: boolean; letter: boolean }
export type Started = { application_id: string; job_id: string; progress: Step[] }

export const keys = {
  brief: (id: string) => ['application', id, 'brief'] as const,
  rewrites: (id: string) => ['application', id, 'rewrites'] as const,
  gaps: (id: string) => ['application', id, 'gaps'] as const,
  cv: (id: string) => ['application', id, 'cv'] as const,
  job: (id: string) => ['job', id] as const,
}

export const isFinished = (s: Job['status'] | undefined) => s === 'done' || s === 'failed'

export function useBrief(id: string) {
  return useQuery({ queryKey: keys.brief(id), queryFn: () => api.get<Brief>(`/v1/applications/${id}/brief`) })
}

/** Polls a pipeline job every 1.5 s until it is done or failed. */
export function usePipelineJob(jobId: string | null | undefined) {
  return useQuery({
    queryKey: keys.job(jobId ?? ''),
    queryFn: () => api.get<PipelineJob>(`/v1/jobs/${jobId}`),
    enabled: !!jobId,
    refetchInterval: (q) => (isFinished(q.state.data?.status) ? false : 1500),
  })
}

export function useStartApplication() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: StartInput) => api.post<Started>('/v1/applications/start', input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['home'] })
      qc.invalidateQueries({ queryKey: ['usage'] })
      qc.invalidateQueries({ queryKey: ['applications'] })
    },
  })
}

export function useRetryPipeline(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.post<{ job_id: string; progress: Step[] }>(`/v1/applications/${id}/pipeline/retry`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.brief(id) })
      qc.invalidateQueries({ queryKey: ['home'] })
    },
  })
}

export function useRewrites(id: string) {
  return useQuery({ queryKey: keys.rewrites(id), queryFn: () => api.get<Rewrites>(`/v1/applications/${id}/rewrites`) })
}

/** Everything that shows the decided CV or the score goes stale after a decision. */
function invalidateDecided(qc: ReturnType<typeof useQueryClient>, id: string) {
  qc.invalidateQueries({ queryKey: keys.brief(id) })
  qc.invalidateQueries({ queryKey: keys.cv(id) })
  qc.invalidateQueries({ queryKey: ['home'] })
}

/** Accept, keep or edit one rewrite. The server is the only place a decision is made. */
export function useDecideRewrite(appId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ rewriteId, decision }: { rewriteId: string; decision: Decision }) =>
      api.patch<{ rewrite: Rewrite; score: Score }>(`/v1/rewrites/${rewriteId}`, decision),
    onSuccess: ({ rewrite, score }) => {
      qc.setQueryData<Rewrites>(keys.rewrites(appId), (old) =>
        old ? { ...old, score, rewrites: old.rewrites.map((r) => (r.id === rewrite.id ? rewrite : r)) } : old,
      )
      invalidateDecided(qc, appId)
    },
  })
}

export function useDecideSummary(appId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (decision: Decision) => api.patch<{ score: Score }>(`/v1/applications/${appId}/summary`, decision),
    onSuccess: ({ score }, decision) => {
      qc.setQueryData<Rewrites>(keys.rewrites(appId), (old) => {
        if (!old?.summary) return old
        const status = decision.action === 'keep' ? 'kept' : 'accepted'
        const proposed = decision.action === 'edit' ? decision.text : old.summary.proposed
        return { ...old, score, summary: { ...old.summary, status, proposed } }
      })
      invalidateDecided(qc, appId)
    },
  })
}

export function useRescore(appId: string) {
  return useMutation({
    mutationFn: () => api.post<{ job_id: string; cv_version_id: string }>(`/v1/applications/${appId}/rescore`),
  })
}

export function useGaps(id: string) {
  return useQuery({ queryKey: keys.gaps(id), queryFn: () => api.get<{ gaps: Gap[] }>(`/v1/applications/${id}/gaps`) })
}

function replaceGap(qc: ReturnType<typeof useQueryClient>, appId: string, gap: Gap) {
  qc.setQueryData<{ gaps: Gap[] }>(keys.gaps(appId), (old) =>
    old ? { gaps: old.gaps.map((g) => (g.id === gap.id ? gap : g)) } : old,
  )
  invalidateDecided(qc, appId)
}

export type GapAnswer = { have: true; text: string; entry: number } | { have: false; text?: string }

export function useAnswerGap(appId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ gapId, answer }: { gapId: string; answer: GapAnswer }) =>
      api.post<{ gap: Gap; note?: string | null }>(`/v1/gaps/${gapId}/answer`, answer),
    onSuccess: ({ gap }) => replaceGap(qc, appId, gap),
  })
}

export function useDecideGapBullet(appId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ gapId, bullet }: { gapId: string; bullet: 'accept' | 'discard' }) =>
      api.patch<{ gap: Gap }>(`/v1/gaps/${gapId}`, { bullet }),
    onSuccess: ({ gap }) => replaceGap(qc, appId, gap),
  })
}

export function useTailoredCv(id: string, enabled = true) {
  return useQuery({ queryKey: keys.cv(id), queryFn: () => api.get<TailoredCv>(`/v1/applications/${id}/cv`), enabled })
}

/** "Halcyon Health" or a stand-in while the job is still being read. */
export function companyName(company: string | null | undefined) {
  return company?.trim() || 'New job'
}
