import { useEffect, useState } from "react"
import {
  FileText,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  ShieldCheck,
  Save,
  ShieldAlert,
} from "lucide-react"
import {
  sidecar,
  type IdeationCandidate,
  type PrecheckResponse,
  type RenderResponse,
  type SimilarityCheckResponse,
  type TaskRecord,
} from "./api"

interface Props {
  renderResult: RenderResponse
  datasetName: string
  /** Whatever the IdeationPanel produced for the current chart, so the R11
   *  gate can compare the human question against those drafts (the handbook
   *  bans AI-generation of submission content). */
  ideationDrafts: IdeationCandidate[]
  /** Seeded from the IdeationPanel "Send to Pre-check" handler — same shape
   *  the PreCheckPanel already uses, so the user typically clicks
   *  Pre-check -> Assemble in order. */
  seed?: { question: string; answer: string; format_spec: string }
  /** Latest precheck verdict for this chart, if the user ran it. We snapshot
   *  it into the saved task so future analysis can see "this passed both
   *  gates at save time". */
  latestPrecheck?: PrecheckResponse | null
  onSaved?: (task: TaskRecord) => void
}

export function TaskAssemblyPanel({
  renderResult,
  datasetName,
  ideationDrafts,
  seed,
  latestPrecheck,
  onSaved,
}: Props) {
  const [question, setQuestion] = useState("")
  const [answer, setAnswer] = useState("")
  const [formatSpec, setFormatSpec] = useState("")
  const [notes, setNotes] = useState("")
  const [reasoningType, setReasoningType] = useState("chart")
  const [verificationExpr, setVerificationExpr] = useState("")
  const [trapValue, setTrapValue] = useState("")

  const [similarity, setSimilarity] = useState<SimilarityCheckResponse | null>(null)
  const [checking, setChecking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<TaskRecord | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Seed from ideation when the user clicks "Send to Pre-check" upstream —
  // we treat that as "I want to assemble this candidate", so populate.
  useEffect(() => {
    if (!seed) return
    setQuestion(seed.question)
    setAnswer(seed.answer)
    setFormatSpec(seed.format_spec)
    setSaved(null)
    setSimilarity(null)
  }, [seed])

  const runR11 = async () => {
    if (!question.trim()) {
      setError("write the question before checking similarity")
      return
    }
    setChecking(true)
    setError(null)
    try {
      const drafts = ideationDrafts.map((d) => d.draft_question).filter(Boolean)
      const r = await sidecar.similarityCheck({
        text: question,
        against: drafts,
        include_saved: true,
      })
      setSimilarity(r)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setChecking(false)
    }
  }

  const canSave =
    question.trim().length > 0 &&
    answer.trim().length > 0 &&
    formatSpec.trim().length > 0 &&
    similarity !== null &&
    !similarity.blocked

  const doSave = async () => {
    if (!canSave) return
    setSaving(true)
    setError(null)
    try {
      const precheckSummary = latestPrecheck
        ? {
            submittable: latestPrecheck.submittable,
            difficulty_pass: latestPrecheck.difficulty_pass,
            quality_pass: latestPrecheck.quality_pass,
            quality_gate_enabled: latestPrecheck.quality_gate_enabled,
            gpt_pass_rate: latestPrecheck.gpt.pass_rate,
            // Snapshot null when Kimi was skipped — keeps the saved record
            // honest so Tracker can tell "skipped" from "failed at 0%".
            kimi_pass_rate: latestPrecheck.quality_gate_enabled
              ? latestPrecheck.kimi.pass_rate
              : null,
          }
        : null
      const record = await sidecar.tasks.save({
        dataset_name: datasetName,
        recipe_id: renderResult.recipe_id,
        chart_fingerprint: renderResult.metadata.fingerprint,
        reasoning_type: reasoningType,
        question: question.trim(),
        ideal_answer: answer.trim(),
        format_spec: formatSpec.trim(),
        verification_expression: verificationExpr.trim(),
        trap_value: trapValue.trim(),
        notes: notes.trim(),
        precheck: precheckSummary,
      })
      setSaved(record)
      onSaved?.(record)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const resetForNext = () => {
    setQuestion("")
    setAnswer("")
    setFormatSpec("")
    setNotes("")
    setVerificationExpr("")
    setTrapValue("")
    setSimilarity(null)
    setSaved(null)
    setError(null)
  }

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-sm">
        <FileText className="size-4 text-muted-foreground" />
        <span className="font-medium">Task Assembly</span>
        <span className="text-xs text-muted-foreground">
          · the final question — R11 gate runs at save
        </span>
        {latestPrecheck?.submittable && (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-500">
            <CheckCircle2 className="size-3" />
            {latestPrecheck.quality_gate_enabled
              ? "Pre-check passed"
              : "Pre-check passed (proxy mode)"}
          </span>
        )}
        {latestPrecheck && !latestPrecheck.submittable && (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-500">
            <AlertTriangle className="size-3" />
            Pre-check not passing
          </span>
        )}
      </div>

      <div className="space-y-3 p-3">
        {saved ? (
          <SavedConfirmation record={saved} onReset={resetForNext} />
        ) : (
          <>
            <Field label="Question" hint="written in your own words — NOT copy-pasted from a draft">
              <textarea
                value={question}
                onChange={(e) => {
                  setQuestion(e.target.value)
                  setSimilarity(null)
                }}
                rows={3}
                placeholder="e.g. Across the four panels, which state has the second-highest mean in the 2010s and what is that mean to one decimal place?"
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm font-sans focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </Field>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Field label="Ideal answer" hint="exact, definitive — from Compute pane">
                <input
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  placeholder="e.g. 8.4"
                  className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </Field>
              <Field label="Format spec" hint="how the answer must be formatted">
                <input
                  value={formatSpec}
                  onChange={(e) => setFormatSpec(e.target.value)}
                  placeholder="e.g. number to 1 decimal place"
                  className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </Field>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Field label="Reasoning type">
                <select
                  value={reasoningType}
                  onChange={(e) => setReasoningType(e.target.value)}
                  className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  <option value="chart">chart</option>
                  <option value="counting">counting</option>
                  <option value="spatial">spatial</option>
                  <option value="puzzle">puzzle</option>
                  <option value="stem">stem</option>
                  <option value="structured-text">structured-text</option>
                </select>
              </Field>
              <Field label="Trap value (optional)" hint="the wrong-but-tempting number">
                <input
                  value={trapValue}
                  onChange={(e) => setTrapValue(e.target.value)}
                  className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </Field>
            </div>

            <Field label="Verification expression (optional)" hint="pandas on `df` that yields the ideal answer">
              <input
                value={verificationExpr}
                onChange={(e) => setVerificationExpr(e.target.value)}
                placeholder="e.g. df[df['state']=='Texas']['mean_unemployment'].iloc[0]"
                className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </Field>

            <Field label="Notes (optional)">
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </Field>

            <SimilarityBlock
              similarity={similarity}
              checking={checking}
              onCheck={runR11}
              poolHint={`${ideationDrafts.length} brainstorm draft${
                ideationDrafts.length === 1 ? "" : "s"
              } + saved tasks`}
            />

            {error && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs">
                <AlertTriangle className="mt-0.5 size-3.5 text-amber-500" />
                <span className="break-words">{error}</span>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
              <span className="mr-auto text-[11px] text-muted-foreground">
                {canSave
                  ? "Ready to save — task will be appended to data/tasks.jsonl."
                  : similarity?.blocked
                    ? "R11 gate blocked — rewrite the question to lower the score."
                    : !similarity
                      ? "Run the R11 check before saving."
                      : "Fill in question, answer, and format spec."}
              </span>
              <button
                disabled={!canSave || saving}
                onClick={doSave}
                className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:bg-foreground/90 disabled:opacity-50"
              >
                {saving ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" />
                    Saving…
                  </>
                ) : (
                  <>
                    <Save className="size-3.5" />
                    Save task
                  </>
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="block space-y-1">
      <div className="flex items-baseline gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        {hint && <span className="text-[10px] text-muted-foreground/80">{hint}</span>}
      </div>
      {children}
    </label>
  )
}

function SimilarityBlock({
  similarity,
  checking,
  onCheck,
  poolHint,
}: {
  similarity: SimilarityCheckResponse | null
  checking: boolean
  onCheck: () => void
  poolHint: string
}) {
  return (
    <div className="rounded-md border border-border bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <ShieldCheck className="size-3.5" />
          R11 similarity gate
        </div>
        <button
          onClick={onCheck}
          disabled={checking}
          className="inline-flex items-center gap-1 rounded border border-border bg-background px-2 py-1 text-[11px] hover:bg-muted disabled:opacity-50"
        >
          {checking ? (
            <>
              <Loader2 className="size-3 animate-spin" />
              Checking…
            </>
          ) : similarity ? (
            "Re-check"
          ) : (
            "Run R11 check"
          )}
        </button>
      </div>
      <p className="mt-1 text-[10px] text-muted-foreground">
        Pool: {poolHint}. Score ≥ {(similarity?.threshold ?? 0.85) * 100}% blocks save.
      </p>
      {similarity && (
        <div className="mt-2 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground">Max score:</span>
            <span
              className={`font-mono text-sm ${
                similarity.blocked ? "text-red-500" : "text-emerald-500"
              }`}
            >
              {(similarity.max_score * 100).toFixed(1)}%
            </span>
            {similarity.blocked ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-500">
                <ShieldAlert className="size-3" />
                Blocked — rewrite
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-500">
                <CheckCircle2 className="size-3" />
                Cleared
              </span>
            )}
          </div>
          {similarity.match && (
            <div className="rounded border border-dashed border-border bg-background p-2">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Closest match
              </div>
              <p className="mt-0.5 text-xs italic text-foreground/80 break-words">
                {similarity.match}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function SavedConfirmation({
  record,
  onReset,
}: {
  record: TaskRecord
  onReset: () => void
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm">
        <CheckCircle2 className="mt-0.5 size-4 text-emerald-500" />
        <div className="space-y-1">
          <p className="font-medium">Task saved.</p>
          <p className="text-xs text-muted-foreground">
            ID <span className="font-mono">{record.id}</span> · saved{" "}
            <span className="font-mono">{record.created_at}</span>
          </p>
        </div>
      </div>
      <div className="rounded-md border border-border bg-muted/20 p-2 text-xs">
        <p className="text-foreground/90">{record.question}</p>
        <p className="mt-1 text-muted-foreground">
          Answer: <span className="font-mono">{record.ideal_answer}</span> ·
          Format: <span className="font-mono">{record.format_spec}</span>
        </p>
      </div>
      <div className="flex justify-end">
        <button
          onClick={onReset}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs hover:bg-muted"
        >
          Compose another
        </button>
      </div>
    </div>
  )
}
