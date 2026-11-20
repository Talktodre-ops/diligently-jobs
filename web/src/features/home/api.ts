// Home: GET /v1/home for the cards and timeline, GET /v1/applications for the
// desktop pipeline overview and the empty state. Shapes per docs/api.md and
// backend/src/routes/home.rs.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api/client'

export type NeedsYouCard = {
  type: 'follow_up' | 'retry' | 'review' | 'prepare'
  application_id: string
  reminder_id?: string
  company: string | null
  role: string | null
  due_at?: string
  pending?: number
  text: string
}

export type WeekEvent = {
  at: string
  kind: string
  application_id: string | null
  company: string | null
  role: string | null
  text: string
}

export type HomeData = {
  first_name: string | null
  needs_you: NeedsYouCard[]
  this_week: WeekEvent[]
  stats: { applied_this_week: number; active: number; interviewing: number }
  setup: Setup
}

/** The four setup milestones, each read from the account's data. */
export type Setup = {
  cv: boolean
  check: boolean
  targets: boolean
  first_application: boolean
  /** Set only while the card is hidden. */
  hidden_until: string | null
  /** Something is left and the card is not hidden. */
  show: boolean
}

export const homeKey = ['home'] as const

export type Stage = 'saved' | 'applied' | 'interviewing' | 'offer' | 'closed'
export type ApplicationListItem = {
  id: string
  company: string | null
  role: string | null
  status: string
  stage: Stage
  created_at: string
  updated_at: string
}

export function useHome() {
  return useQuery({ queryKey: homeKey, queryFn: () => api.get<HomeData>('/v1/home') })
}

/** Hide the setup card for a week, on every device. */
export function useHideSetup() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.post<void>('/v1/setup/hide'),
    onSuccess: () => {
      qc.setQueryData<HomeData>(homeKey, (h) => (h ? { ...h, setup: { ...h.setup, show: false } } : h))
      return qc.invalidateQueries({ queryKey: homeKey })
    },
  })
}

/** The user confirmed what we read from their CV. */
export function useCvChecked() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.post<void>('/v1/setup/cv-checked'),
    onSuccess: () => qc.invalidateQueries({ queryKey: homeKey }),
  })
}

/** Newest first. The list endpoint also returns each job's full text, so keep the page small. */
export function useApplications(limit = 40) {
  return useQuery({
    queryKey: ['applications', { limit }],
    queryFn: () => api.get<ApplicationListItem[]>(`/v1/applications?limit=${limit}`),
  })
}
