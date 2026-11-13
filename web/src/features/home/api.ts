// Home: GET /v1/home for the cards and timeline, GET /v1/applications for the
// desktop pipeline overview and the empty state. Shapes per docs/api.md and
// backend/src/routes/home.rs.
import { useQuery } from '@tanstack/react-query'
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
}

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
  return useQuery({ queryKey: ['home'], queryFn: () => api.get<HomeData>('/v1/home') })
}

/** Newest first. The list endpoint also returns each job's full text, so keep the page small. */
export function useApplications(limit = 40) {
  return useQuery({
    queryKey: ['applications', { limit }],
    queryFn: () => api.get<ApplicationListItem[]>(`/v1/applications?limit=${limit}`),
  })
}
