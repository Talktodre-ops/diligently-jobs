import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import type { Profile } from '../api/types'
import { profileKey } from './session'

/** This browser's IANA zone, or null when the browser does not say. */
export function browserTimeZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return zone && zone !== 'Etc/Unknown' ? zone : null
  } catch {
    return null
  }
}

/**
 * Reminders go out at a local hour, so the API needs the person's zone. When a
 * signed-in profile has none yet, send the browser's once. A failure is not
 * shown: the server keeps using UTC and Settings still lets the person pick.
 */
export function useSyncTimeZone(profile: Profile | undefined) {
  const qc = useQueryClient()
  const tried = useRef(false)
  // `reminders` is checked too so an API without the field is left alone.
  const missing = !!profile?.reminders && profile.reminders.time_zone === null
  useEffect(() => {
    if (!missing || tried.current) return
    const zone = browserTimeZone()
    if (!zone) return
    tried.current = true
    api
      .patch<{ profile: Profile }>('/v1/profile', { reminders: { time_zone: zone } })
      .then(({ profile: next }) => qc.setQueryData(profileKey, next))
      .catch((e: unknown) => console.warn('Could not save the time zone', e))
  }, [missing, qc])
}
