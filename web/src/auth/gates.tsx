import { Navigate, Outlet, useLocation } from 'react-router'
import { PageState } from '../ui/PageState'
import { useMe, useProfile } from './session'

const onboardingPath = {
  upload: '/onboarding/upload',
  check: '/onboarding/check',
  targets: '/onboarding/targets',
} as const

/** Welcome, sign up, sign in: a signed-in visitor goes home instead. */
export function PublicOnly() {
  const me = useMe()
  if (me.isPending) return <PageState.Loading />
  if (me.isError) return <PageState.Error error={me.error} onRetry={() => me.refetch()} />
  if (me.data) return <Navigate to="/" replace />
  return <Outlet />
}

/** Needs a session, nothing more (verify-email reminder, onboarding). */
export function RequireSession() {
  const me = useMe()
  const location = useLocation()
  if (me.isPending) return <PageState.Loading />
  if (me.isError) return <PageState.Error error={me.error} onRetry={() => me.refetch()} />
  if (!me.data) return <Navigate to="/welcome" replace state={{ from: location.pathname + location.search }} />
  return <Outlet />
}

/** The app proper: signed in, email verified, onboarding finished. */
export function RequireAccount() {
  const me = useMe()
  const location = useLocation()
  const profile = useProfile(!!me.data?.email_verified)
  if (me.isPending) return <PageState.Loading />
  if (me.isError) return <PageState.Error error={me.error} onRetry={() => me.refetch()} />
  if (!me.data) return <Navigate to="/welcome" replace state={{ from: location.pathname + location.search }} />
  if (!me.data.email_verified) return <Navigate to="/verify-email" replace />
  if (profile.isPending) return <PageState.Loading />
  if (profile.isError) return <PageState.Error error={profile.error} onRetry={() => profile.refetch()} />
  const step = profile.data.onboarding_step
  if (step !== 'done') return <Navigate to={onboardingPath[step]} replace />
  return <Outlet />
}
