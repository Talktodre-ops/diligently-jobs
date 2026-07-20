import { useCallback, useEffect, useState } from "react"
import {
  FileText,
  Loader2,
  AlertTriangle,
  Copy,
  Trash2,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Search,
  Calendar,
  Database,
} from "lucide-react"
import { sidecar, type TaskRecord } from "./api"

export function AuthorView() {
  const [tasks, setTasks] = useState<TaskRecord[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState("")
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const r = await sidecar.tasks.list()
      setTasks(r)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const onDelete = async (id: string) => {
    if (!confirm("Delete this task? This cannot be undone (file rewrite).")) return
    setDeletingId(id)
    try {
      await sidecar.tasks.delete(id)
      setTasks((prev) => prev?.filter((t) => t.id !== id) ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setDeletingId(null)
    }
  }

  const filtered =
    tasks?.filter((t) => {
      if (!q.trim()) return true
      const needle = q.toLowerCase()
      return (
        t.question.toLowerCase().includes(needle) ||
        t.ideal_answer.toLowerCase().includes(needle) ||
        t.dataset_name.toLowerCase().includes(needle) ||
        t.id.toLowerCase().includes(needle)
      )
    }) ?? null

  if (error) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
          <AlertTriangle className="mt-0.5 size-4 text-amber-500" />
          <div>
            <p className="text-sm font-medium">Couldn't load tasks</p>
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
          Loading saved tasks…
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Author</h1>
          <p className="text-sm text-muted-foreground">
            {tasks.length} saved task{tasks.length === 1 ? "" : "s"} on disk
            <span className="ml-2 font-mono text-[10px]">data/tasks.jsonl</span>
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

      <div className="relative">
        <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by question, answer, dataset, or id"
          className="h-8 w-full rounded-md border border-border bg-background pl-7 pr-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      {tasks.length === 0 && (
        <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
          No tasks saved yet. Render a chart in the Pantry, brainstorm, then
          assemble a task to populate this list.
        </div>
      )}

      <div className="space-y-3">
        {filtered?.map((t) => (
          <TaskCard
            key={t.id}
            task={t}
            onDelete={() => onDelete(t.id)}
            deleting={deletingId === t.id}
          />
        ))}
      </div>
    </div>
  )
}

function TaskCard({
  task,
  onDelete,
  deleting,
}: {
  task: TaskRecord
  onDelete: () => void
  deleting: boolean
}) {
  const [copiedField, setCopiedField] = useState<string | null>(null)

  const copy = async (field: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopiedField(field)
      setTimeout(() => setCopiedField(null), 1200)
    } catch {
      /* ignore */
    }
  }

  return (
    <article className="rounded-xl border border-border bg-card">
      <header className="flex items-start gap-2 border-b border-border p-3">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
          <FileText className="size-3.5 text-muted-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[10px] text-muted-foreground">
              {task.id}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">
              <Database className="size-2.5" />
              {task.dataset_name}
            </span>
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {task.reasoning_type}
            </span>
            {task.precheck && (
              <PrecheckBadge precheck={task.precheck} />
            )}
            <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-muted-foreground">
              <Calendar className="size-2.5" />
              {task.created_at}
            </span>
          </div>
        </div>
      </header>

      <div className="space-y-3 p-3">
        <section className="space-y-1">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Question
            </p>
            <button
              onClick={() => copy("q", task.question)}
              className="inline-flex items-center gap-1 rounded border border-border bg-background px-1.5 py-0.5 text-[10px] hover:bg-muted"
            >
              <Copy className="size-2.5" />
              {copiedField === "q" ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="text-sm text-foreground/90">{task.question}</p>
        </section>

        <div className="grid grid-cols-1 gap-2 text-xs md:grid-cols-2">
          <FieldRow
            label="Ideal answer"
            value={task.ideal_answer}
            mono
            onCopy={() => copy("a", task.ideal_answer)}
            copied={copiedField === "a"}
          />
          <FieldRow
            label="Format"
            value={task.format_spec}
            onCopy={() => copy("f", task.format_spec)}
            copied={copiedField === "f"}
          />
        </div>

        {task.verification_expression && (
          <FieldRow
            label="Verification expression"
            value={task.verification_expression}
            mono
            onCopy={() => copy("v", task.verification_expression!)}
            copied={copiedField === "v"}
          />
        )}

        {task.trap_value && (
          <FieldRow
            label="Trap value"
            value={task.trap_value}
            mono
            onCopy={() => copy("t", task.trap_value!)}
            copied={copiedField === "t"}
          />
        )}

        {task.notes && (
          <FieldRow
            label="Notes"
            value={task.notes}
            onCopy={() => copy("n", task.notes!)}
            copied={copiedField === "n"}
          />
        )}

        <div className="flex items-center justify-between pt-2">
          <p className="text-[10px] text-muted-foreground">
            Recipe: <span className="font-mono">{task.recipe_id}</span> · chart{" "}
            <span className="font-mono">{task.chart_fingerprint.slice(0, 8)}</span>
          </p>
          <button
            onClick={onDelete}
            disabled={deleting}
            className="inline-flex items-center gap-1 rounded border border-border bg-background px-2 py-1 text-[11px] text-red-500 hover:bg-red-500/10 disabled:opacity-50"
          >
            {deleting ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Trash2 className="size-3" />
            )}
            Delete
          </button>
        </div>
      </div>
    </article>
  )
}

function FieldRow({
  label,
  value,
  mono,
  onCopy,
  copied,
}: {
  label: string
  value: string
  mono?: boolean
  onCopy: () => void
  copied: boolean
}) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <button
          onClick={onCopy}
          className="inline-flex items-center gap-1 rounded border border-border bg-background px-1.5 py-0.5 text-[10px] hover:bg-muted"
        >
          <Copy className="size-2.5" />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className={mono ? "break-words font-mono text-xs text-foreground/90" : "text-xs text-foreground/90"}>
        {value}
      </p>
    </div>
  )
}

function PrecheckBadge({ precheck }: { precheck: NonNullable<TaskRecord["precheck"]> }) {
  const kimi =
    precheck.kimi_pass_rate === null || precheck.kimi_pass_rate === undefined
      ? "Kimi skipped"
      : `Kimi ${(precheck.kimi_pass_rate * 100).toFixed(0)}%`
  if (precheck.submittable) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-500">
        <CheckCircle2 className="size-2.5" />
        precheck OK · GPT {(precheck.gpt_pass_rate * 100).toFixed(0)}% · {kimi}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-500">
      <XCircle className="size-2.5" />
      precheck fail · GPT {(precheck.gpt_pass_rate * 100).toFixed(0)}% · {kimi}
    </span>
  )
}
