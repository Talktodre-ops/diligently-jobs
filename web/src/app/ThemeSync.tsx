import { useEffect } from 'react'
import { useMe, useProfile } from '../auth/session'

/**
 * Applies the saved theme to <html>. tokens.css reacts to data-theme, and
 * "system" means no attribute so the OS preference decides. Nothing is fetched
 * when signed out (useProfile stays disabled until there is a session).
 */
export function ThemeSync() {
  const me = useMe()
  const profile = useProfile(!!me.data?.email_verified)
  const theme = profile.data?.theme
  useEffect(() => {
    const root = document.documentElement
    if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme)
    else root.removeAttribute('data-theme')
    // Leaving the app (sign-out) returns public pages to the system theme.
    return () => root.removeAttribute('data-theme')
  }, [theme])
  return null
}
