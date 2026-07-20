import { useEffect, useState } from "react"
import {
  ShieldCheck,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronRight,
} from "lucide-react"
import { sidecar, type PrecheckResponse, type PrecheckRun } from "./api"

/**
 * Pre-Check panel — runs the platform's GPT + Kimi gates locally before you
 * burn a submission slot.
 *
 * - GPT pass-rate must be ≤ 0.5 (≤ 2/4) → "difficulty" gate.
 * - Kimi pass-rate must be ≥ 0.25 (≥ 1/4) → "quality" gate.
 * - submittable = both gates pass.
 */

interface PreCheckPanelProps {
  imageB64: string
  /** Optionally seed the form from an Ideation candidate. */
  initial?: { question?: string; answer?: string; format_spec?: string }
  /** Lift the latest verdict so downstream panels (Task Assembly) can snapshot it. */
  onReport?: (report: PrecheckResponse | null) => void
}

const RUN_KIMI_KEY = "realmq.precheck.runKimi"

export function PreCheckPanel({ imageB64, initial, onReport }: PreCheckPanelProps) {
  const [question, setQuestion] = useState(initial?.question ?? "")
  const [answer, setAnswer] = useState(initial?.answer ?? "")
  const [formatSpec, setFormatSpec] = useState(initial?.format_spec ?? "")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [report, setReport] = useState<PrecheckResponse | null>(null)
  // Persist the Kimi-gate preference across sessions — the user typically
  // either has Moonshot funded (keep on) or not (keep off), and toggling on
  // every chart is friction.
  const [runKimi, setRunKimi] = useState<boolean>(() => {
    if (typeof window === "undefined") return true
    const raw = window.localStorage.getItem(RUN_KIMI_KEY)
    return raw === null ? true : raw === "1"
  })
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(RUN_KIMI_KEY, runKimi ? "1" : "0")
    }
  }, [runKimi])

  useEffect(() => {
    onReport?.(report)
    // Intentionally not depending on onReport — parents typically pass an
    // inline callback, and we only care about report-change events.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report])

  const run = async () => {
    if (!question.trim() || !answer.trim()) {
      setError("question and canonical answer are both required")
      return
    }
    setBusy(true)
    setError(null)
    try {
      const r = await sidecar.precheck({
        image_b64: imageB64,
        question,
        answer,
        format_spec: formatSpec,
        run_kimi: runKimi,
      })
      setReport(r)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setReport(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-sm">
        <ShieldCheck className="size-4 text-muted-foreground" />
        <span className="font-medium">Rollout Pre-Check</span>
        <span className="text-xs text-muted-foreground">
          · 4 GPT runs + 4 Kimi runs · mirrors the platform's accept gate
        </span>
      </div>

      <div className="space-y-2 p-3">
        <div>
          <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Question
          </label>
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            rows={3}
            placeholder="Your final question — what gets sent to the platform."
            className="mt-1 w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-foreground/30"
          />
        </div>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          <div>
            <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Canonical answer (what graders match)
            </label>
            <input
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder='e.g. "California" or "42.3"'
              className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-foreground/30"
            />
          </div>
          <div>
            <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Format spec (optional)
            </label>
            <input
              value={formatSpec}
              onChange={(e) => setFormatSpec(e.target.value)}
              placeholder="e.g. Round to 2 decimals."
              className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-foreground/30"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={run}
            disabled={busy || !question.trim() || !answer.trim()}
            className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:bg-foreground/90 disabled:opacity-50"
          >
            {busy ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Running {runKimi ? "8" : "4"} vision calls…
              </>
            ) : report ? (
              <>
                <ShieldCheck className="size-3.5" />
                Re-run pre-check
              </>
            ) : (
              <>
                <ShieldCheck className="size-3.5" />
                Run pre-check{runKimi ? " (4 GPT + 4 Kimi)" : " (4 GPT only)"}
              </>
            )}
          </button>
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11px]">
            <input
              type="checkbox"
              checked={runKimi}
              onChange={(e) => setRunKimi(e.target.checked)}
              className="size-3.5 cursor-pointer accent-foreground"
            />
            <span>Run Kimi quality gate</span>
            {!runKimi && (
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-500">
                proxy mode — GPT only
              </span>
            )}
          </label>
          <span className="text-[10px] text-muted-foreground">
            ~{runKimi ? "10–20s · ~$0.10" : "5–10s · ~$0.05"}/run
          </span>
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs">
            <AlertTriangle className="mt-0.5 size-3.5 text-amber-500 shrink-0" />
            <div className="space-y-1">
              <p className="font-medium break-words">{error}</p>
              {(error.includes("OPENAI_API_KEY") ||
                error.includes("MOONSHOT_API_KEY")) && (
                <p className="text-muted-foreground">
                  Pre-check needs <span className="font-mono">OPENAI_API_KEY</span>{" "}
                  (GPT proxy) and <span className="font-mono">MOONSHOT_API_KEY</span>{" "}
                  (Kimi proxy) in <span className="font-mono">sidecar/.env</span>.
                  Restart the Tauri app after editing so the sidecar reloads.
                </p>
              )}
            </div>
          </div>
        )}

        {report && <PrecheckReport report={report} />}
      </div>
    </div>
  )
}

function PrecheckReport({ report }: { report: PrecheckResponse }) {
  return (
    <div className="space-y-3">
      <VerdictBanner report={report} />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <ModelReport
          title="GPT (difficulty gate)"
          subtitle={`pass-rate must be ≤ ${(report.gpt.threshold * 100).toFixed(0)}%`}
          data={report.gpt}
          good={report.difficulty_pass}
          goodLabel="hard enough"
          badLabel="too easy — GPT solving it too often"
        />
        {report.quality_gate_enabled ? (
          <ModelReport
            title="Kimi (quality gate)"
            subtitle={`pass-rate must be ≥ ${(report.kimi.threshold * 100).toFixed(0)}%`}
            data={report.kimi}
            good={report.quality_pass}
            goodLabel="clear enough"
            badLabel="too unclear — Kimi can't even reach the answer"
          />
        ) : (
          <SkippedKimiCard />
        )}
      </div>
    </div>
  )
}

function SkippedKimiCard() {
  return (
    <div className="rounded-lg border border-dashed border-border bg-muted/20 p-3">
      <p className="text-sm font-medium">Kimi (quality gate) · skipped</p>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Moonshot calls were disabled for this run. Submittable status reflects
        the GPT difficulty gate only — there's no local signal that the
        question is clear enough for a capable VLM to converge on the answer.
      </p>
      <p className="mt-2 text-[10px] text-amber-500">
        Re-enable the Kimi gate once Moonshot is funded for full platform parity.
      </p>
    </div>
  )
}

function VerdictBanner({ report }: { report: PrecheckResponse }) {
  if (report.submittable) {
    const proxyMode = !report.quality_gate_enabled
    return (
      <div className="flex items-start gap-3 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm">
        <CheckCircle2 className="mt-0.5 size-4 text-emerald-500" />
        <div>
          <p className="font-semibold text-emerald-700 dark:text-emerald-400">
            {proxyMode ? "Submittable (proxy mode — GPT only)" : "Submittable"}
          </p>
          <p className="mt-0.5 text-xs text-emerald-600/90 dark:text-emerald-400/80">
            {proxyMode
              ? `Difficulty gate passes: GPT ${report.gpt.n_passed}/${report.gpt.n_runs}. Kimi quality gate was skipped — the platform still runs it, so verify clarity manually.`
              : `Both platform gates pass locally. GPT pass ${report.gpt.n_passed}/${report.gpt.n_runs} · Kimi pass ${report.kimi.n_passed}/${report.kimi.n_runs}.`}
          </p>
        </div>
      </div>
    )
  }
  return (
    <div className="flex items-start gap-3 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm">
      <XCircle className="mt-0.5 size-4 text-red-500" />
      <div>
        <p className="font-semibold text-red-700 dark:text-red-400">
          Not submittable yet
        </p>
        <p className="mt-0.5 text-xs text-red-600/90 dark:text-red-400/80">
          {!report.difficulty_pass &&
            `GPT passed too often (${report.gpt.n_passed}/${report.gpt.n_runs}) — make it harder. `}
          {report.quality_gate_enabled && !report.quality_pass &&
            `Kimi never reached the answer (${report.kimi.n_passed}/${report.kimi.n_runs}) — clarify wording or check the canonical answer.`}
        </p>
      </div>
    </div>
  )
}

function ModelReport({
  title,
  subtitle,
  data,
  good,
  goodLabel,
  badLabel,
}: {
  title: string
  subtitle: string
  data: PrecheckResponse["gpt"]
  good: boolean
  goodLabel: string
  badLabel: string
}) {
  const [open, setOpen] = useState(false)
  const pct = (data.pass_rate * 100).toFixed(0)
  return (
    <div className="rounded-lg border border-border bg-background">
      <div className="border-b border-border p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium">{title}</p>
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
              good
                ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                : "bg-red-500/15 text-red-600 dark:text-red-400"
            }`}
          >
            {good ? goodLabel : badLabel}
          </span>
        </div>
        <p className="mt-0.5 text-[10px] text-muted-foreground">{subtitle}</p>
        <div className="mt-2 flex items-baseline gap-2">
          <span className="text-2xl font-semibold tabular-nums">
            {data.n_passed}/{data.n_runs}
          </span>
          <span className="text-xs text-muted-foreground">
            ({pct}% pass) · {data.model}
          </span>
        </div>
      </div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] hover:bg-muted"
      >
        {open ? (
          <ChevronDown className="size-3" />
        ) : (
          <ChevronRight className="size-3" />
        )}
        <span>Per-run answers</span>
      </button>
      {open && (
        <div className="space-y-1.5 border-t border-border p-2">
          {data.runs.map((r, i) => (
            <RunRow key={i} index={i + 1} run={r} />
          ))}
        </div>
      )}
    </div>
  )
}

function RunRow({ index, run }: { index: number; run: PrecheckRun }) {
  const [showFull, setShowFull] = useState(false)
  return (
    <div className="rounded-md border border-border/60 bg-background p-2 text-[11px]">
      <div className="flex items-start gap-2">
        {run.passed ? (
          <CheckCircle2 className="mt-0.5 size-3 text-emerald-500" />
        ) : (
          <XCircle className="mt-0.5 size-3 text-red-500" />
        )}
        <div className="flex-1 min-w-0">
          <p>
            <span className="text-muted-foreground">Run {index}:</span>{" "}
            <span className="font-mono">
              {run.extracted_answer || "(no answer extracted)"}
            </span>
          </p>
          <button
            onClick={() => setShowFull((v) => !v)}
            className="mt-1 text-[10px] text-muted-foreground hover:text-foreground"
          >
            {showFull ? "Hide full response" : "Show full response"}
          </button>
          {showFull && (
            <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-1.5 font-mono text-[10px]">
              {run.full_response}
            </pre>
          )}
        </div>
      </div>
    </div>
  )
}
