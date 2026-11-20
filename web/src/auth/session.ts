import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, isApiError } from '../api/client'
import type { Profile, User } from '../api/types'

export const meKey = ['me'] as const
export const profileKey = ['profile'] as const

/** The signed-in user, or null when there is no session. */
export function useMe() {
  return useQuery({
    queryKey: meKey,
    queryFn: async (): Promise<User | null> => {
      try {
        const { user } = await api.get<{ user: User }>('/v1/auth/me')
        return user
      } catch (e) {
        if (isApiError(e) && e.status === 401) return null
        throw e
      }
    },
    staleTime: 60_000,
  })
}

export function useProfile(enabled = true) {
  return useQuery({
    queryKey: profileKey,
    queryFn: async () => (await api.get<{ profile: Profile }>('/v1/profile')).profile,
    enabled,
    staleTime: 30_000,
  })
}

/** Call after sign-in, sign-up or sign-out so every gate re-reads the session. */
export function useResetSession() {
  const qc = useQueryClient()
  return async (user: User | null) => {
    qc.clear()
    qc.setQueryData(meKey, user)
  }
}
