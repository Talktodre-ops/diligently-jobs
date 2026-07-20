import { useCallback, useEffect, useMemo, useState } from "react"
import {
  BarChart3,
  Loader2,
  AlertTriangle,
  RefreshCw,
  Target,
  TrendingUp,
  ShieldCheck,
} from "lucide-react"
import { sidecar, type TaskRecord } from "./api"

// Per the brief: 75-150 signed-off tasks/week is the throughput target.
const WEEKLY_TARGET_LOW = 75
const WEEKLY_TARGET_HIGH = 150

export function TrackerView() {
  const [tasks, setTasks] = useState<TaskRecord[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      setTasks(await sidecar.tasks.list())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const stats = useMemo(() => computeStats(tasks ?? []), [tasks])

  if (error) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
          <AlertTriangle className="mt-0.5 size-4 text-amber-500" />
          <div>
            <p className="text-sm font-medium">Couldn't load tracker</p>
            <p className="mt-1 text-xs text-muted-foreground break-words">{error}</p>
          </div>
        </div>
      </div>
    )
  }

  if (tasks === null) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading tracker…
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Tracker</h1>
          <p className="text-sm text-muted-foreground">
            Throughput vs the {WEEKLY_TARGET_LOW}–{WEEKLY_TARGET_HIGH}/week target.
          </p>
        </div>
        <button
          onClick={load}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs hover:bg-muted"
        >
          <RefreshCw className="size-3.5" />
          Refresh
        </button>
      </header>

      <section className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <StatCard
          icon={<Target className="size-4" />}
          label="This week"
          value={stats.thisWeek}
          subline={weekTargetLabel(stats.thisWeek)}
          tone={weekTone(stats.thisWeek)}
        />
        <StatCard
          icon={<TrendingUp className="size-4" />}
          label="Last 4 weeks"
          value={stats.last4Weeks}
          subline={`${(stats.last4Weeks / 4).toFixed(1)}/wk avg`}
        />
        <StatCard
          icon={<ShieldCheck className="size-4" />}
          label="Pre-check passing"
          value={stats.precheckPassing}
          subline={`${stats.total === 0 ? "—" : ((100 * stats.precheckPassing) / stats.total).toFixed(0) + "%"} of all saved`}
        />
      </section>

      <section className="rounded-xl border border-border bg-card">
        <header className="flex items-center gap-2 border-b border-border px-3 py-2 text-sm">
          <BarChart3 className="size-4 text-muted-foreground" />
          <span className="font-medium">Per-week throughput</span>
          <span className="text-xs text-muted-foreground">
            · last 8 weeks · ISO Mon–Sun
          </span>
        </header>
        <div className="space-y-2 p-4">
          {stats.weekly.map((w) => (
            <WeekBar key={w.weekStart} week={w} />
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card">
        <header className="flex items-center gap-2 border-b border-border px-3 py-2 text-sm">
          <span className="font-medium">By dataset</span>
        </header>
        <div className="divide-y divide-border">
          {Object.entries(stats.byDataset).length === 0 && (
            <p className="p-4 text-xs text-muted-foreground">No tasks yet.</p>
          )}
          {Object.entries(stats.byDataset).map(([name, count]) => (
            <div
              key={name}
              className="flex items-center justify-between px-3 py-2 text-sm"
            >
              <span className="font-mono">{name}</span>
              <span className="tabular-nums text-muted-foreground">{count}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

interface WeekStat {
  weekStart: string // "YYYY-MM-DD" of Monday
  count: number
}

function computeStats(tasks: TaskRecord[]) {
  const now = new Date()
  const thisWeekStart = mondayOf(now)
  const fourWeeksAgo = new Date(thisWeekStart)
  fourWeeksAgo.setDate(thisWeekStart.getDate() - 21) // 4 weeks inclusive

  const weekly = lastNWeeks(now, 8).map<WeekStat>((d) => ({
    weekStart: isoDate(d),
    count: 0,
  }))

  let thisWeek = 0
  let last4Weeks = 0
  let precheckPassing = 0
  const byDataset: Record<string, number> = {}

  for (const t of tasks) {
    const created = new Date(t.created_at_epoch * 1000)
    const monday = mondayOf(created)
    const mondayIso = isoDate(monday)

    const slot = weekly.find((w) => w.weekStart === mondayIso)
    if (slot) slot.count += 1

    if (monday >= thisWeekStart) thisWeek += 1
    if (monday >= fourWeeksAgo) last4Weeks += 1
    if (t.precheck?.submittable) precheckPassing += 1
    byDataset[t.dataset_name] = (byDataset[t.dataset_name] ?? 0) + 1
  }

  return {
    total: tasks.length,
    thisWeek,
    last4Weeks,
    precheckPassing,
    weekly,
    byDataset,
  }
}

function mondayOf(d: Date): Date {
  const out = new Date(d)
  out.setHours(0, 0, 0, 0)
  const day = out.getDay() // 0=Sun..6=Sat
  const shift = day === 0 ? -6 : 1 - day
  out.setDate(out.getDate() + shift)
  return out
}

function lastNWeeks(now: Date, n: number): Date[] {
  const start = mondayOf(now)
  const out: Date[] = []
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(start)
    d.setDate(start.getDate() - i * 7)
    out.push(d)
  }
  return out
}

function isoDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

function weekTargetLabel(count: number): string {
  if (count >= WEEKLY_TARGET_HIGH) return `${count} · over target (${WEEKLY_TARGET_HIGH})`
  if (count >= WEEKLY_TARGET_LOW) return `${count} · on target (${WEEKLY_TARGET_LOW}–${WEEKLY_TARGET_HIGH})`
  return `${count} · below target (need ≥ ${WEEKLY_TARGET_LOW})`
}

function weekTone(count: number): "good" | "warn" | "neutral" | undefined {
  if (count >= WEEKLY_TARGET_LOW) return "good"
  if (count >= WEEKLY_TARGET_LOW / 2) return "warn"
  return undefined
}

function StatCard({
  icon,
  label,
  value,
  subline,
  tone,
}: {
  icon: React.ReactNode
  label: string
  value: number | string
  subline: string
  tone?: "good" | "warn" | "neutral"
}) {
  const toneClass =
    tone === "good"
      ? "border-emerald-500/40 bg-emerald-500/5"
      : tone === "warn"
        ? "border-amber-500/40 bg-amber-500/5"
        : "border-border bg-card"
  return (
    <div className={`rounded-xl border p-4 ${toneClass}`}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{subline}</p>
    </div>
  )
}

function WeekBar({ week }: { week: WeekStat }) {
  // Scale relative to the high target so the bar fills at 150/week.
  const pct = Math.min(100, (week.count / WEEKLY_TARGET_HIGH) * 100)
  const onTarget = week.count >= WEEKLY_TARGET_LOW
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="font-mono text-muted-foreground">{week.weekStart}</span>
        <span
          className={`tabular-nums ${onTarget ? "text-emerald-500" : "text-muted-foreground"}`}
        >
          {week.count}
        </span>
      </div>
      <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
        {/* Target window overlay (75-150). */}
        <div
          className="absolute inset-y-0 border-l border-r border-emerald-500/40"
          style={{
            left: `${(WEEKLY_TARGET_LOW / WEEKLY_TARGET_HIGH) * 100}%`,
            right: 0,
          }}
        />
        <div
          className={`h-full ${onTarget ? "bg-emerald-500" : "bg-foreground/40"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}
