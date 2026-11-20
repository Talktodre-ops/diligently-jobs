import { api } from './client'

/** Product events the funnel reads. Most steps come from data the API keeps; these are the ones it cannot see. */
export type TrackKind = 'files_downloaded'

/**
 * Record one product event. Fire and forget: a failed record never gets in
 * the user's way. Payloads hold choices, never personal details.
 */
export function track(kind: TrackKind, applicationId: string | null, payload: Record<string, string | number | boolean> = {}) {
  api.post('/v1/events', { kind, application_id: applicationId, payload }).catch(() => {})
}
