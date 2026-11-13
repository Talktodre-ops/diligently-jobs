import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import s from './UsageCard.module.css'

export type Usage = { plan: string; applications_this_month: number; monthly_limit: number | null; resets_on: string }

export function useUsage() {
  return useQuery({ queryKey: ['usage'], queryFn: () => api.get<Usage>('/v1/usage'), staleTime: 60_000 })
}

/** "12 of 40 this month" in the desktop side menu. */
export function UsageCard() {
  const usage = useUsage()
  if (!usage.data) return null
  const { applications_this_month: used, monthly_limit: limit } = usage.data
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0
  return (
    <div className={s.card}>
      <div className={s.row}><span>This month</span><strong>{limit ? `${used} of ${limit}` : `${used}`}</strong></div>
      {limit ? (
        <div className={s.track} role="meter" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used} aria-label="Applications used this month">
          <div className={s.fill} style={{ width: `${pct}%` }} />
        </div>
      ) : null}
    </div>
  )
}
