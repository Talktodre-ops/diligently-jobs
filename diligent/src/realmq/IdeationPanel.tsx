import { useEffect, useState } from "react"
import {
  Lightbulb,
  Loader2,
  AlertTriangle,
  Pin,
  PinOff,
  Trash2,
  Target,
  Quote,
  FlaskConical,
  Play,
  ShieldCheck,
} from "lucide-react"
import { sidecar, type IdeationCandidate, type RenderResponse } from "./api"

interface IdeationPanelProps {
  renderResult: RenderResponse
  datasetName: string
  datasetDescription: string
  /** Called with a verification expression to evaluate it in the compute pane. */
  onUseInCompute?: (expression: string) => void
  /** Called with (question, answer, format_spec) to seed the pre-check panel. */
  onSendToPrecheck?: (q: { question: string; answer: string; format_spec: string }) => void
  /** Lift the kept candidates so the R11 gate downstream can compare against them. */
  onCandidates?: (candidates: IdeationCandidate[]) => void
}

type IdeationVendor = "claude" | "deepseek_hybrid" | "deepseek" | "openai" | "moonshot"

const VENDOR_KEY = "realmq.ideation.vendor"

const VENDOR_OPTS: { value: IdeationVendor; label: string; note: string; vision: boolean }[] = [
  {
    value: "claude",
    label: "Claude",
    note: "Vision-capable. Default — best for visual-edge-case questions (layout, color, marker shapes). Fast.",
    vision: true,
  },
  {
    value: "deepseek_hybrid",
    label: "Hybrid (Claude vision → DeepSeek-Pro)",
    note: "Hard mode. Claude extracts a structured chart description, then DeepSeek-v4-pro thinking mode reasons from it + the records. Best on hard multi-step + trap-design questions. ~3-5× cost (still pennies) + ~2× latency.",
    vision: true,
  },
  {
    value: "deepseek",
    label: "DeepSeek-v4-pro (text-only)",
    note: "Text-only — reasons from columns + records + chart guidance (no image). Strongest at multi-step numeric reasoning. Cheaper than hybrid but no visual grounding.",
    vision: false,
  },
  {
    value: "openai",
    label: "OpenAI",
    note: "Vision-capable GPT. Same model used in pre-check; useful for sanity comparison.",
    vision: true,
  },
  {
    value: "moonshot",
    label: "Moonshot/Kimi",
    note: "Vision-capable. Cheap alt; mirrors the platform's Kimi gate.",
    vision: true,
  },
]

export function IdeationPanel({
  renderResult,
  datasetName,
  datasetDescription,
  onUseInCompute,
  onSendToPrecheck,
  onCandidates,
}: IdeationPanelProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<IdeationCandidate[] | null>(null)
  const [rejected, setRejected] = useState<number>(0)
  const [model, setModel] = useState<string>("")
  const [pinned, setPinned] = useState<Set<number>>(new Set())
  const [discarded, setDiscarded] = useState<Set<number>>(new Set())
  const [vendor, setVendor] = useState<IdeationVendor>(() => {
    if (typeof window === "undefined") return "claude"
    const stored = window.localStorage.getItem(VENDOR_KEY)
    const valid: IdeationVendor[] = [
      "claude",
      "deepseek_hybrid",
      "deepseek",
      "openai",
      "moonshot",
    ]
    return (valid as string[]).includes(stored ?? "")
      ? (stored as IdeationVendor)
      : "claude"
  })
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(VENDOR_KEY, vendor)
    }
  }, [vendor])

  const vendorMeta = VENDOR_OPTS.find((v) => v.value === vendor) ?? VENDOR_OPTS[0]

  useEffect(() => {
    onCandidates?.(candidates ?? [])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidates])

  const ideate = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await sidecar.ideate({
        image_b64: renderResult.png_b64,
        dataset_name: datasetName,
        dataset_description: datasetDescription,
        chart_metadata: renderResult.metadata as unknown as Record<string, unknown>,
        records: renderResult.records,
        reasoning_type: "chart",
        n_candidates: 5,
        vendor,
      })
      setCandidates(r.candidates)
      setRejected(r.rejected.length)
      setModel(r.model)
      setPinned(new Set())
      setDiscarded(new Set())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-sm">
        <Lightbulb className="size-4 text-muted-foreground" />
        <span className="font-medium">Question Ideation (brainstorm)</span>
        <span className="text-xs text-muted-foreground">
          · candidate angles only — you write the final question
        </span>
        <label className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
          Vendor
          <select
            value={vendor}
            onChange={(e) => setVendor(e.target.value as IdeationVendor)}
            disabled={busy}
            className="h-7 rounded-md border border-border bg-background px-2 text-xs font-mono"
            title={vendorMeta.note}
          >
            {VENDOR_OPTS.map((v) => (
              <option key={v.value} value={v.value}>
                {v.label}
                {!v.vision ? " (text-only)" : ""}
              </option>
            ))}
          </select>
        </label>
        <button
          onClick={ideate}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:bg-foreground/90 disabled:opacity-50"
        >
          {busy ? (
            <>
              <Loader2 className="size-3.5 animate-spin" />
              Brainstorming…
            </>
          ) : candidates ? (
            <>
              <Lightbulb className="size-3.5" />
              Re-brainstorm
            </>
          ) : (
            <>
              <Lightbulb className="size-3.5" />
              Brainstorm 5 angles
            </>
          )}
        </button>
      </div>
      {!vendorMeta.vision && (
        <div className="border-b border-border bg-amber-500/5 px-3 py-1.5 text-[11px] text-muted-foreground">
          <span className="font-medium text-amber-500">Text-only vendor:</span>{" "}
          {vendorMeta.note}
        </div>
      )}

      <div className="p-3 space-y-3">
        {!candidates && !error && (
          <p className="text-xs text-muted-foreground">
            Brainstorm produces 5 unobvious reasoning angles for this chart. Each
            candidate is a <em>DRAFT</em> — read it for inspiration, then write
            your own question in your own words. The R11 similarity gate at submit
            will block verbatim lifts.
          </p>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs">
            <AlertTriangle className="mt-0.5 size-3.5 text-amber-500 shrink-0" />
            <div className="space-y-1">
              <p className="font-medium">{error}</p>
              {(error.includes("ANTHROPIC_API_KEY") ||
                error.includes("OPENAI_API_KEY") ||
                error.includes("MOONSHOT_API_KEY") ||
                error.includes("DEEPSEEK_API_KEY")) && (
                <p className="text-muted-foreground">
                  Set the missing key in{" "}
                  <span className="font-mono">RealmQ/sidecar/.env</span> (copy{" "}
                  <span className="font-mono">.env.example</span>) and restart the
                  Tauri app so the sidecar reloads. Ideation uses{" "}
                  <span className="font-mono">ANTHROPIC_API_KEY</span> (Claude) by default.
                </p>
              )}
            </div>
          </div>
        )}

        {candidates && (
          <>
            <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
              <span>
                Model: <span className="font-mono">{model}</span>
              </span>
              <span>
                Kept: <span className="font-mono">{candidates.length}</span>
              </span>
              {rejected > 0 && (
                <span title="Candidates dropped by the rule-based pre-filter (binary phrasing, ambiguity, etc.)">
                  Filtered: <span className="font-mono">{rejected}</span>
                </span>
              )}
            </div>

            <div className="space-y-2">
              {candidates.map((c, i) => {
                const isPinned = pinned.has(i)
                const isDiscarded = discarded.has(i)
                if (isDiscarded) return null
                return (
                  <CandidateCard
                    key={i}
                    candidate={c}
                    pinned={isPinned}
                    onPin={() => {
                      const next = new Set(pinned)
                      if (next.has(i)) next.delete(i)
                      else next.add(i)
                      setPinned(next)
                    }}
                    onDiscard={() => {
                      const next = new Set(discarded)
                      next.add(i)
                      setDiscarded(next)
                    }}
                    onUseInCompute={onUseInCompute}
                    onSendToPrecheck={onSendToPrecheck}
                  />
                )
              })}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function CandidateCard({
  candidate,
  pinned,
  onPin,
  onDiscard,
  onUseInCompute,
  onSendToPrecheck,
}: {
  candidate: IdeationCandidate
  pinned: boolean
  onPin: () => void
  onDiscard: () => void
  onUseInCompute?: (expr: string) => void
  onSendToPrecheck?: (q: { question: string; answer: string; format_spec: string }) => void
}) {
  const difficulty = candidate.predicted_difficulty
  const diffColor =
    difficulty <= 0.4
      ? "text-emerald-500"
      : difficulty <= 0.6
        ? "text-amber-500"
        : "text-red-500"

  return (
    <article
      className={`rounded-lg border p-3 transition-colors ${
        pinned ? "border-blue-500/40 bg-blue-500/5" : "border-border bg-background"
      }`}
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0 space-y-2">
          <header className="flex items-center gap-2">
            <span className="rounded-full bg-foreground/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-foreground">
              DRAFT — REWRITE
            </span>
            <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {candidate.reasoning_type}
            </span>
            <span className="ml-auto text-[10px] text-muted-foreground">
              GPT-pass est:{" "}
              <span className={`font-mono ${diffColor}`}>
                {(difficulty * 100).toFixed(0)}%
              </span>
            </span>
          </header>

          <p className="text-sm text-foreground/90">
            <span className="font-semibold">Angle:</span> {candidate.angle}
          </p>

          <div className="rounded-md border border-dashed border-border bg-muted/30 p-2 text-xs italic text-muted-foreground">
            <Quote className="mr-1 inline-block size-3" />
            {candidate.draft_question}
          </div>

          <div className="grid grid-cols-1 gap-2 text-xs md:grid-cols-2">
            <div>
              <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                <Target className="size-3" /> Ideal answer
              </div>
              <p className="font-mono text-foreground">{candidate.ideal_answer}</p>
              <p className="mt-0.5 text-[10px] text-muted-foreground">
                Format: <span className="font-mono">{candidate.format_spec}</span>
              </p>
            </div>
            <div>
              <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                <AlertTriangle className="size-3" /> Trap value
              </div>
              <p className="font-mono text-foreground/80">{candidate.trap_value}</p>
            </div>
          </div>

          <div className="rounded-md border border-border bg-muted/20 p-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                <FlaskConical className="size-3" /> Verification expression
              </div>
              {onUseInCompute && (
                <button
                  onClick={() => onUseInCompute(candidate.verification_expression)}
                  className="inline-flex items-center gap-1 rounded border border-border bg-background px-1.5 py-0.5 text-[10px] hover:bg-muted"
                >
                  <Play className="size-2.5" />
                  Send to Compute
                </button>
              )}
            </div>
            <p className="mt-1 break-words font-mono text-[11px] text-foreground/80">
              {candidate.verification_expression}
            </p>
          </div>

          {onSendToPrecheck && (
            <div className="flex justify-end">
              <button
                onClick={() =>
                  onSendToPrecheck({
                    question: candidate.draft_question,
                    answer: candidate.ideal_answer,
                    format_spec: candidate.format_spec,
                  })
                }
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-[10px] hover:bg-muted"
                title="Seed the Pre-check panel with this candidate (you still rewrite the question before submission)"
              >
                <ShieldCheck className="size-3" />
                Send to Pre-check
              </button>
            </div>
          )}
        </div>

        <div className="flex shrink-0 flex-col gap-1">
          <button
            onClick={onPin}
            title={pinned ? "Unpin" : "Pin"}
            className={`rounded-md p-1.5 ${pinned ? "bg-blue-500/15 text-blue-500" : "text-muted-foreground hover:bg-muted"}`}
          >
            {pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
          </button>
          <button
            onClick={onDiscard}
            title="Discard"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      </div>
    </article>
  )
}
