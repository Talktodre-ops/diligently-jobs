import { googleStartUrl, useProviders } from '../api'
import s from './GoogleButton.module.css'

/**
 * "Continue with Google", shown only when the API has Google configured. It is
 * a plain link: Google sign-in is a full-page round trip through the API.
 */
export function GoogleButton({ next }: { next: string }) {
  const providers = useProviders()
  if (!providers.data?.google) return null
  return (
    <>
      <a className={s.google} href={googleStartUrl(next)}>
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 12h8" />
        </svg>
        Continue with Google
      </a>
      <div className={s.or}><span className={s.rule} />or with email<span className={s.rule} /></div>
    </>
  )
}
