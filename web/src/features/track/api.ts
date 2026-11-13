import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api/client'

export type Stage = 'saved' | 'applied' | 'interviewing' | 'offer' | 'closed'

export const STAGES: { id: Stage; label: string; empty: { title: string; body: string } }[] = [
  { id: 'saved', label: 'Drafting', empty: { title: 'Nothing in progress', body: 'Jobs you have started but not sent wait here.' } },
  { id: 'applied', label: 'Applied', empty: { title: 'Nothing sent yet', body: 'When you send a CV, mark it as applied and it moves here with a follow-up reminder.' } },
  { id: 'interviewing', label: 'Interview', empty: { title: 'No interviews yet', body: 'When a company invites you, move the job here and we will help you prepare.' } },
  { id: 'offer', label: 'Offer', empty: { title: 'No offers yet', body: 'When one lands, move it here and we will help you compare.' } },
  { id: 'closed', label: 'Closed', empty: { title: 'Nothing closed', body: 'Move a job here when it is over, so it stops asking for your attention.' } },
]

export type TrackedApp = {
  id: string
  company: string | null
  role: string | null
  status: string
  stage: Stage
  submitted_at: string | null
  created_at: string
  updated_at: string
}

export const applicationsKey = ['applications'] as const

export function useApplications() {
  return useQuery({
    queryKey: applicationsKey,
    queryFn: () => api.get<TrackedApp[]>('/v1/applications?limit=500'),
  })
}

export function useSetStage() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, stage }: { id: string; stage: Stage }) => api.patch<{ stage: Stage }>(`/v1/applications/${id}/stage`, { stage }),
    onSuccess: (_d, { id, stage }) => {
      qc.setQueryData<TrackedApp[]>(applicationsKey, (old) => old?.map((a) => (a.id === id ? { ...a, stage } : a)))
      void qc.invalidateQueries({ queryKey: ['home'] })
      void qc.invalidateQueries({ queryKey: applicationsKey })
    },
  })
}

type HomeCard = { type: string; application_id?: string; reminder_id?: string; due_at?: string }

/** Application ids with a follow-up that is due, from the Home feed. */
export function useDueFollowUps() {
  return useQuery({
    queryKey: ['home', 'due'],
    queryFn: async () => {
      const home = await api.get<{ needs_you: HomeCard[] }>('/v1/home')
      return new Set(home.needs_you.filter((c) => c.type === 'follow_up' && c.application_id).map((c) => c.application_id!))
    },
  })
}

/** The current match score for a card, from the workspace brief. */
export function useMatchScore(id: string, enabled: boolean) {
  return useQuery({
    queryKey: ['brief-score', id],
    enabled,
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      const brief = await api.get<{ score?: { current?: number | null } | null }>(`/v1/applications/${id}/brief`)
      return brief.score?.current ?? null
    },
  })
}

export type Reminder = { id: string; application_id: string; due_at: string; status: string; sent_at: string | null }
export type Draft = { id: string; channel: 'email' | 'linkedin'; subject: string | null; body: string; created_at: string }
export type Channel = 'email' | 'linkedin'

export type FollowUps = { drafts: Record<Channel, Draft | null>; reminder: Reminder | null }

export function useFollowUps(id: string) {
  return useQuery({ queryKey: ['follow-ups', id], queryFn: () => api.get<FollowUps>(`/v1/applications/${id}/follow-ups`) })
}

export function useApplication(id: string) {
  return useQuery({ queryKey: ['application', id], queryFn: () => api.get<TrackedApp>(`/v1/applications/${id}`) })
}

export function useDraftFollowUp(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (channel: Channel) => api.post<{ draft: Draft }>(`/v1/applications/${id}/follow-ups`, { channel }),
    onSuccess: ({ draft }) =>
      qc.setQueryData<FollowUps>(['follow-ups', id], (old) =>
        old ? { ...old, drafts: { ...old.drafts, [draft.channel]: draft } } : old,
      ),
  })
}

export function useReminderAction(id: string) {
  const qc = useQueryClient()
  const onSuccess = ({ reminder }: { reminder: Reminder }) => {
    qc.setQueryData<FollowUps>(['follow-ups', id], (old) => (old ? { ...old, reminder } : old))
    void qc.invalidateQueries({ queryKey: ['home'] })
  }
  const snooze = useMutation({ mutationFn: ({ reminderId, days }: { reminderId: string; days: number }) => api.post<{ reminder: Reminder }>(`/v1/reminders/${reminderId}/snooze`, { days }), onSuccess })
  const done = useMutation({ mutationFn: (reminderId: string) => api.post<{ reminder: Reminder }>(`/v1/reminders/${reminderId}/done`), onSuccess })
  return { snooze, done }
}

const day = 86_400_000
/** "today", "yesterday", "5 days ago", then a short date. */
export function ago(iso: string, now = Date.now()) {
  const days = Math.floor((now - new Date(iso).getTime()) / day)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 14) return `${days} days ago`
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

export function monogram(company: string | null) {
  const words = (company ?? '').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  return (words.length === 1 ? words[0]!.slice(0, 2) : words[0]![0]! + words[1]![0]!).toUpperCase()
}
