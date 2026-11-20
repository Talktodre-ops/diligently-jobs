// Shapes shared across features. Feature-specific response types live next to
// the feature (src/features/<area>/api.ts). docs/api.md is the source of truth.

export type User = {
  id: string
  email: string
  email_verified: boolean
  plan: string
  created_at: string
  /** False for an account that only signs in with Google. */
  has_password: boolean
  google_connected: boolean
  /** Null for Google-only accounts, or when it was never recorded. */
  password_changed_at: string | null
}

export type OnboardingStep = 'upload' | 'check' | 'targets' | 'first_job' | 'done'

export type Notifications = { follow_ups: boolean; weekly_summary: boolean; running_low: boolean; product_news: boolean }

export const FOLLOW_UP_DAYS = [5, 7, 10, 14] as const
export const SEND_HOURS = [9, 13, 18] as const
export type Reminders = {
  follow_up_days: (typeof FOLLOW_UP_DAYS)[number]
  send_hour: (typeof SEND_HOURS)[number]
  /** IANA zone name; null until the app has sent the browser's zone (the server then uses UTC). */
  time_zone: string | null
  skip_weekends: boolean
}

export type LetterTone = 'direct' | 'warm' | 'formal'
/** `spelling` null means the server infers it from the location. */
export type Writing = { spelling: 'en-GB' | 'en-US' | null; letter_tone: LetterTone }

export type Profile = {
  full_name: string | null
  headline: string | null
  location: string | null
  target_roles: string[]
  work_settings: ('remote' | 'hybrid' | 'onsite')[]
  paper_size: 'a4' | 'letter'
  theme: 'system' | 'light' | 'dark'
  notifications: Notifications
  reminders: Reminders
  writing: Writing
  onboarding_step: OnboardingStep
  open_to?: string[] | null
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
