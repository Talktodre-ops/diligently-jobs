// Shapes shared across features. Feature-specific response types live next to
// the feature (src/features/<area>/api.ts). docs/api.md is the source of truth.

export type User = {
  id: string
  email: string
  email_verified: boolean
  plan: string
  created_at: string
}

export type OnboardingStep = 'upload' | 'check' | 'targets' | 'done'

export type Profile = {
  full_name: string | null
  headline: string | null
  location: string | null
  target_roles: string[]
  work_settings: ('remote' | 'hybrid' | 'onsite')[]
  paper_size: 'a4' | 'letter'
  theme: 'system' | 'light' | 'dark'
  notifications: { follow_ups: boolean; interview_prep: boolean; product_news: boolean }
  onboarding_step: OnboardingStep
  updated_at: string
}

export type Job = {
  id: string
  kind: string
  status: 'queued' | 'running' | 'done' | 'failed'
  result: unknown
  attempts: number
  max_attempts: number
  progress: unknown
}
