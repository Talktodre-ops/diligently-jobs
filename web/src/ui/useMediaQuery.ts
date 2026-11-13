import { useSyncExternalStore } from 'react'

/** True while the media query matches. False where matchMedia is missing (tests, old browsers). */
export function useMediaQuery(query: string) {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => {}
      const mql = window.matchMedia(query)
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    },
    () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false),
    () => false,
  )
}

/** The desktop layout starts where AppShell shows its side menu. */
export const DESKTOP = '(min-width: 1024px)'
