import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from 'react'
import { createBrowserRouter, Link } from 'react-router'
import { PublicOnly, RequireAccount, RequireSession } from '../auth/gates'
import { PageState } from '../ui/PageState'
import { AppShell } from './AppShell'

// One lazy chunk per screen keeps the first load small on a phone.
const page = (load: () => Promise<{ default: ComponentType }>) => {
  const C: LazyExoticComponent<ComponentType> = lazy(load)
  return (
    <Suspense fallback={<PageState.Loading />}>
      <C />
    </Suspense>
  )
}

function NotFound() {
  return <PageState.Empty title="Nothing here" body="That page does not exist." action={<Link to="/">Go home</Link>} />
}

export const routes = [
  {
    element: <PublicOnly />,
    children: [
      { path: '/welcome', element: page(() => import('../features/auth/WelcomePage')) },
      { path: '/signup', element: page(() => import('../features/auth/SignUpPage')) },
      { path: '/signin', element: page(() => import('../features/auth/SignInPage')) },
      { path: '/forgot-password', element: page(() => import('../features/auth/ForgotPasswordPage')) },
    ],
  },
  // Email links work in any browser, signed in or not.
  { path: '/verify-email', element: page(() => import('../features/auth/VerifyEmailPage')) },
  { path: '/reset-password', element: page(() => import('../features/auth/ResetPasswordPage')) },
  { path: '/confirm-email', element: page(() => import('../features/auth/ConfirmEmailPage')) },
  {
    element: <RequireSession />,
    children: [
      { path: '/onboarding/upload', element: page(() => import('../features/onboarding/UploadPage')) },
      { path: '/onboarding/check', element: page(() => import('../features/onboarding/CheckPage')) },
      { path: '/onboarding/targets', element: page(() => import('../features/onboarding/TargetsPage')) },
    ],
  },
  {
    element: <RequireAccount />,
    children: [
      {
        element: <AppShell tabs />,
        children: [
          { path: '/', element: page(() => import('../features/home/HomePage')) },
          { path: '/jobs', element: page(() => import('../features/track/JobsPage')) },
          { path: '/documents', element: page(() => import('../features/documents/DocumentsPage')) },
          { path: '/profile', element: page(() => import('../features/account/ProfilePage')) },
        ],
      },
      {
        element: <AppShell tabs={false} />,
        children: [
          { path: '/new', element: page(() => import('../features/apply/NewJobPage')) },
          { path: '/applications/:id', element: page(() => import('../features/apply/WorkspacePage')) },
          { path: '/applications/:id/running', element: page(() => import('../features/apply/RunningPage')) },
          { path: '/applications/:id/review', element: page(() => import('../features/apply/ReviewPage')) },
          { path: '/applications/:id/gaps', element: page(() => import('../features/apply/GapsPage')) },
          { path: '/applications/:id/research', element: page(() => import('../features/documents/ResearchPage')) },
          { path: '/applications/:id/letter', element: page(() => import('../features/documents/CoverLetterPage')) },
          { path: '/applications/:id/cv', element: page(() => import('../features/documents/CvPreviewPage')) },
          { path: '/applications/:id/send', element: page(() => import('../features/documents/SendPage')) },
          { path: '/applications/:id/follow-up', element: page(() => import('../features/track/FollowUpPage')) },
          { path: '/settings', element: page(() => import('../features/account/SettingsPage')) },
        ],
      },
    ],
  },
  { path: '*', element: <NotFound /> },
]

export const router = createBrowserRouter(routes)
