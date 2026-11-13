import { isApiError } from '../api/client'
import { Button } from './Button'
import s from './PageState.module.css'

function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className={s.wrap} role="status" aria-live="polite">
      <span className={s.dot} aria-hidden="true" />
      <span className="visually-hidden">{label}</span>
    </div>
  )
}

function ErrorState({ error, onRetry, title = 'That did not load' }: { error: unknown; onRetry?: () => void; title?: string }) {
  const message = isApiError(error) ? error.message : 'Something went wrong on our side. Try again.'
  return (
    <div className={s.wrap} role="alert">
      <div className={s.title}>{title}</div>
      <p className={s.body}>{message}</p>
      {onRetry && <Button variant="secondary" small onClick={onRetry}>Try again</Button>}
    </div>
  )
}

function Empty({ title, body, action }: { title: string; body?: string; action?: React.ReactNode }) {
  return (
    <div className={s.wrap}>
      <div className={s.title}>{title}</div>
      {body && <p className={s.body}>{body}</p>}
      {action}
    </div>
  )
}

export const PageState = { Loading, Error: ErrorState, Empty }
