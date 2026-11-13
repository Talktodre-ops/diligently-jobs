import { useDecideRewrite, useDecideSummary, type Decision } from './api'
import type { ReviewItem } from './reviewItems'

/** One entry point for deciding a summary or a bullet; tracks which item is in flight. */
export function useDecide(appId: string) {
  const bullet = useDecideRewrite(appId)
  const summary = useDecideSummary(appId)
  const busyId = bullet.isPending ? bullet.variables?.rewriteId : summary.isPending ? 'summary' : null
  const error = bullet.error ?? summary.error
  const errorFor = bullet.error ? bullet.variables?.rewriteId : summary.error ? 'summary' : null

  function decide(item: ReviewItem, decision: Decision, onDone?: () => void) {
    bullet.reset()
    summary.reset()
    if (item.kind === 'summary') summary.mutate(decision, { onSuccess: () => onDone?.() })
    else bullet.mutate({ rewriteId: item.id, decision }, { onSuccess: () => onDone?.() })
  }

  return { decide, busyId: busyId ?? null, error, errorFor: errorFor ?? null, busy: bullet.isPending || summary.isPending }
}
