import { Navigate, useLocation, useParams, useSearchParams } from 'react-router'

type Old = 'running' | 'review' | 'gaps' | 'cv' | 'letter' | 'research' | 'send'

/**
 * Addresses from before the application was one screen: emails, bookmarks
 * and Home cards may still hold them. Each lands on the same thing in the one
 * screen; the tailoring job passed in navigation state comes along.
 */
export function OldApplicationRoute({ was }: { was: Old }) {
  const { id = '' } = useParams()
  const [params] = useSearchParams()
  const location = useLocation()
  const query =
    was === 'letter' ? '?tab=letter'
      : was === 'research' ? '?tab=company'
        : was === 'send' ? '?send=1'
          : was === 'review' ? `?change=${encodeURIComponent(params.get('item') ?? 'next')}`
            : ''
  return <Navigate to={`/applications/${id}${query}`} replace state={location.state} />
}
