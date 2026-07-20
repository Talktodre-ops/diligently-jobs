import { useMemo, useState } from "react"
import { Calculator, Play, Loader2, AlertTriangle, Copy, Check } from "lucide-react"
import { sidecar, type ComputeResponse } from "./api"

interface HelperDef {
  label: string
  expr: string
  hint: string
}

/** Build pandas expression helpers tailored to the current dataset's columns.
 *  Previous version hard-coded `rate_mean` / `state` / `decade_label` which
 *  only exist on multi_panel_bar_errors records — every other recipe blew up
 *  with KeyError. Now we sniff the first record, classify each column as
 *  numeric or string, and template the helpers off whatever's actually
 *  present. Returns the helpers PLUS the inferred column names so the UI can
 *  surface them as a copy-to-clipboard chip row. */
function buildHelpers(records: Record<string, unknown>[]): {
  helpers: HelperDef[]
  numericCols: string[]
  stringCols: string[]
  allCols: string[]
} {
  if (records.length === 0) {
    return { helpers: [], numericCols: [], stringCols: [], allCols: [] }
  }
  const sample = records[0]
  const allCols = Object.keys(sample)
  const numericCols: string[] = []
  const stringCols: string[] = []
  for (const c of allCols) {
    // Inspect the first non-null value across up to 5 rows so a single null in
    // row 0 doesn't misclassify the column.
    for (let i = 0; i < Math.min(records.length, 5); i++) {
      const v = records[i][c]
      if (v === null || v === undefined) continue
      if (typeof v === "number") numericCols.push(c)
      else if (typeof v === "string") stringCols.push(c)
      break
    }
  }
  const n0 = numericCols[0]
  const n1 = numericCols[1] ?? n0
  const s0 = stringCols[0]
  const helpers: HelperDef[] = []
  if (n0 && s0) {
    helpers.push({
      label: "idxmax",
      expr: `df.loc[df['${n0}'].idxmax(),'${s0}']`,
      hint: `${s0} with the highest ${n0}.`,
    })
  }
  if (n0) {
    helpers.push({
      label: "max value",
      expr: `df['${n0}'].max()`,
      hint: `Single largest ${n0}.`,
    })
  }
  if (n0 && n1 && s0) {
    helpers.push({
      label: "filter + sort",
      expr: `df[df['${n0}']>df['${n0}'].mean()].sort_values('${n1}',ascending=False)['${s0}'].iloc[0]`,
      hint: `Top by ${n1} among rows where ${n0} > mean.`,
    })
  }
  if (n0 && s0) {
    helpers.push({
      label: "groupby agg",
      expr: `df.groupby('${s0}')['${n0}'].mean().round(2)`,
      hint: `Mean ${n0} per ${s0}.`,
    })
  }
  if (n0 && s0) {
    const firstVal = String(sample[s0]).replace(/'/g, "")
    helpers.push({
      label: "delta",
      expr: `round(df[df['${s0}']=='${firstVal}']['${n0}'].max() - df['${n0}'].mean(),2)`,
      hint: `Max ${n0} for "${firstVal}" minus overall mean.`,
    })
  }
  return { helpers, numericCols, stringCols, allCols }
}

export function ComputePane({
  records,
  initialExpression,
  title = "Compute-Answer",
}: {
  records: Record<string, unknown>[]
  initialExpression?: string
  title?: string
}) {
  const { helpers, allCols } = useMemo(() => buildHelpers(records), [records])
  const fallbackExpr = helpers[0]?.expr ?? (allCols[0] ? `df['${allCols[0]}']` : "df.head()")
  const [expr, setExpr] = useState(initialExpression ?? fallbackExpr)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<ComputeResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const run = async () => {
    setRunning(true)
    setError(null)
    try {
      const r = await sidecar.compute({ records, expression: expr })
      setResult(r)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setResult(null)
    } finally {
      setRunning(false)
    }
  }

  const copyValue = async () => {
    if (!result) return
    try {
      await navigator.clipboard.writeText(formatValue(result.value))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-sm">
        <Calculator className="size-4 text-muted-foreground" />
        <span className="font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">
          · pandas eval over <span className="font-mono">df</span>
        </span>
      </div>

      {allCols.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Columns
          </span>
          {allCols.map((c) => (
            <button
              key={c}
              onClick={() => {
                // Insert `df['col']` at cursor end — fastest way to start an expression
                // when the user only remembers part of a column name.
                setExpr((prev) => (prev.trim() ? `${prev} df['${c}']` : `df['${c}']`))
              }}
              title={`Insert df['${c}']`}
              className="rounded-md border border-border bg-background px-2 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {c}
            </button>
          ))}
        </div>
      )}

      {helpers.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-b border-border px-3 py-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground self-center">
            Templates
          </span>
          {helpers.map((h) => (
            <button
              key={h.label}
              onClick={() => setExpr(h.expr)}
              title={h.hint}
              className="rounded-md border border-border bg-background px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {h.label}
            </button>
          ))}
        </div>
      )}

      <div className="space-y-2 p-3">
        <textarea
          value={expr}
          onChange={(e) => setExpr(e.target.value)}
          spellCheck={false}
          rows={2}
          className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-foreground/30"
        />

        <div className="flex items-center gap-2">
          <button
            onClick={run}
            disabled={running || !expr.trim()}
            className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:bg-foreground/90 disabled:opacity-50"
          >
            {running ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Running…
              </>
            ) : (
              <>
                <Play className="size-3.5" />
                Run
              </>
            )}
          </button>
          {result && (
            <button
              onClick={copyValue}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-muted"
            >
              {copied ? (
                <>
                  <Check className="size-3.5 text-emerald-500" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="size-3.5" />
                  Copy result
                </>
              )}
            </button>
          )}
          {result && (
            <span className="text-[10px] text-muted-foreground">
              type: <span className="font-mono">{result.value_type}</span>
            </span>
          )}
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs">
            <AlertTriangle className="mt-0.5 size-3.5 text-amber-500" />
            <span className="font-mono break-words text-muted-foreground">
              {error}
            </span>
          </div>
        )}

        {result && (
          <div className="rounded-md border border-emerald-500/20 bg-emerald-500/5 p-2 font-mono text-xs">
            <pre className="whitespace-pre-wrap break-words">
              {formatValue(result.value)}
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "null"
  if (typeof v === "string") return v
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  return JSON.stringify(v, null, 2)
}
