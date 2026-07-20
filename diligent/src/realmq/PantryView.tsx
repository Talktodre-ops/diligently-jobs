import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Loader2,
  AlertTriangle,
  Database,
  RefreshCw,
  Image as ImageIcon,
  Shuffle,
  ChevronDown,
  ChevronRight,
  X,
  Eye,
  EyeOff,
  Sliders,
  Calculator,
  Lightbulb,
  ShieldCheck,
  FileText,
  CheckCircle2,
} from "lucide-react"
import {
  sidecar,
  type Dataset,
  type IdeationCandidate,
  type PrecheckResponse,
  type RenderResponse,
  type UsageResponse,
} from "./api"
import { ChartViewer } from "./ChartViewer"
import { ComputePane } from "./ComputePane"
import { IdeationPanel } from "./IdeationPanel"
import { PreCheckPanel } from "./PreCheckPanel"
import { TaskAssemblyPanel } from "./TaskAssemblyPanel"
import {
  VariantChips,
  VARIANT_AWARE_RECIPES,
  type VariantState,
} from "./VariantChips"

/** Lowest pair count for a dataset across saved tasks. Used so the recipe
 *  picker auto-selects the least-saturated option for whatever dataset the
 *  user is working in. Falls back to suggested_recipes[0] when no usage row
 *  exists yet (cold start). */
function leastUsedRecipe(
  dataset: Dataset,
  usage: UsageResponse | null
): string {
  const suggested = dataset.suggested_recipes
  if (!suggested.length) return ""
  if (!usage) return suggested[0]
  let best = suggested[0]
  let bestCount = Infinity
  for (const r of suggested) {
    const row = usage.by_pair.find(
      (p) => p.dataset_name === dataset.name && p.recipe_id === r
    )
    const c = row?.count ?? 0
    if (c < bestCount) {
      bestCount = c
      best = r
    }
  }
  return best
}

export function PantryView() {
  const [datasets, setDatasets] = useState<Dataset[] | null>(null)
  const [usage, setUsage] = useState<UsageResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Accordion: at most one dataset expanded at a time. Compact cards above /
  // below collapse to a one-line header so the page doesn't become a scroll
  // graveyard. State stays in each DatasetCard instance (all stay mounted)
  // so user work isn't lost when they switch datasets.
  const [activeDatasetName, setActiveDatasetName] = useState<string | null>(null)

  const refetchUsage = useCallback(() => {
    sidecar.tasks
      .usage()
      .then(setUsage)
      .catch(() => {
        // Usage is purely advisory — silently no-op rather than block the UI.
      })
  }, [])

  useEffect(() => {
    let cancelled = false
    sidecar
      .datasets()
      .then((d) => !cancelled && setDatasets(d))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
    refetchUsage()
    return () => {
      cancelled = true
    }
  }, [refetchUsage])

  const shufflePantry = useCallback(() => {
    if (!datasets || datasets.length === 0) return
    // Pick the dataset with the lowest saved-task count (0 if absent from
    // usage). Tie-breaks deterministically by dataset.name to keep the UX
    // predictable across clicks when several are equally cold.
    const byDataset = usage?.by_dataset ?? {}
    let target = datasets[0]
    let lowest = byDataset[target.name] ?? 0
    for (const d of datasets) {
      const c = byDataset[d.name] ?? 0
      if (c < lowest) {
        target = d
        lowest = c
      }
    }
    setActiveDatasetName(target.name)
    // Defer scroll until after the expanded card renders.
    requestAnimationFrame(() => {
      const node = document.getElementById(`dataset-card-${target.name}`)
      node?.scrollIntoView({ behavior: "smooth", block: "start" })
    })
  }, [datasets, usage])

  // Variety stats — MUST be declared before any early returns so React's hook
  // order stays stable across loading → loaded → error transitions. (Calling a
  // hook conditionally crashes the whole tree with "Rendered fewer/more hooks
  // than during the previous render".)
  const varietyLine = useMemo(() => {
    const nDatasets = datasets?.length ?? 0
    if (!usage || usage.total === 0) {
      return `${nDatasets} datasets · 0 recipes · 0 tasks saved`
    }
    const ds = Object.entries(usage.by_dataset)
    const rc = Object.keys(usage.by_recipe).length
    if (ds.length === 0) {
      return `${nDatasets} datasets · ${rc} recipes · ${usage.total} tasks saved`
    }
    ds.sort((a, b) => b[1] - a[1])
    const top = ds[0]
    const bottom = ds[ds.length - 1]
    return (
      `${ds.length} datasets · ${rc} recipes · ${usage.total} tasks saved · ` +
      `most-used: ${top[0]} (${top[1]}x), least-used: ${bottom[0]} (${bottom[1]}x)`
    )
  }, [usage, datasets])

  if (error) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
          <AlertTriangle className="mt-0.5 size-4 text-amber-500" />
          <div>
            <p className="text-sm font-medium">Couldn't load datasets</p>
            <p className="mt-1 text-xs text-muted-foreground break-words">{error}</p>
          </div>
        </div>
      </div>
    )
  }

  if (datasets === null) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading pantry…
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <header className="space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Pantry</h1>
            <p className="text-sm text-muted-foreground">
              {datasets.length} curated CC0/PD dataset{datasets.length === 1 ? "" : "s"} ·
              pick one and render a chart to start authoring against it.
            </p>
          </div>
          <button
            onClick={shufflePantry}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted"
            title="Jump to the least-used dataset"
          >
            <Shuffle className="size-3.5" />
            Shuffle Pantry
          </button>
        </div>
        <p className="text-[11px] text-muted-foreground">{varietyLine}</p>
      </header>

      <div className="space-y-2">
        {datasets.map((d) => (
          <DatasetCard
            key={d.name}
            dataset={d}
            usage={usage}
            onTaskSaved={refetchUsage}
            isActive={activeDatasetName === d.name}
            onOpen={() => setActiveDatasetName(d.name)}
            onClose={() => setActiveDatasetName(null)}
          />
        ))}
      </div>
    </div>
  )
}

type WorkTab = "chart" | "compute" | "brainstorm" | "precheck" | "assemble"

function DatasetCard({
  dataset,
  usage,
  onTaskSaved,
  isActive,
  onOpen,
  onClose,
}: {
  dataset: Dataset
  usage: UsageResponse | null
  onTaskSaved: () => void
  isActive: boolean
  onOpen: () => void
  onClose: () => void
}) {
  const [seed, setSeed] = useState(42)
  // Increments each Shuffle click; the live seed is derived from this so the
  // input value reflects the actual seed used for the next render.
  const [shuffleN, setShuffleN] = useState(0)
  const [selectedRecipe, setSelectedRecipe] = useState<string>(
    () => leastUsedRecipe(dataset, usage)
  )
  const [rendering, setRendering] = useState(false)
  const [result, setResult] = useState<RenderResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  // When ideation pushes a verification expression to the compute pane, we
  // bump this so ComputePane re-mounts with the new initialExpression.
  const [computeKey, setComputeKey] = useState(0)
  const [computeExpr, setComputeExpr] = useState<string | undefined>(undefined)
  // Same pattern for the pre-check panel — seeded from an ideation candidate.
  const [precheckKey, setPrecheckKey] = useState(0)
  const [precheckSeed, setPrecheckSeed] = useState<
    { question: string; answer: string; format_spec: string } | undefined
  >(undefined)
  // Lifted state so the Task Assembly panel can run the R11 gate against
  // brainstorm drafts and snapshot the latest precheck verdict on save.
  const [ideationDrafts, setIdeationDrafts] = useState<IdeationCandidate[]>([])
  const [latestPrecheck, setLatestPrecheck] = useState<PrecheckResponse | null>(null)
  // Variant-axis selections (aggregation/smoothing/normalization/highlight).
  // Only applied when the selected recipe is variant-aware; otherwise hidden
  // from the UI and not passed in the render params.
  const [variants, setVariants] = useState<VariantState>({})
  // Tabbed workspace inside the active card. Defaults to chart but auto-flips
  // when the user clicks "Send to Compute" / "Send to Pre-check" on an
  // ideation candidate — that's the natural follow-up action.
  const [tab, setTab] = useState<WorkTab>("chart")
  // Track what was last actually rendered so we can flag when the controls
  // have drifted (user changed seed / recipe / variants but hasn't clicked
  // Re-render yet). Surfaces a dirty indicator on the Re-render button.
  const [lastRendered, setLastRendered] = useState<{
    recipe: string
    seed: number
    variants: VariantState
  } | null>(null)
  // Collapse states: keep the active card from looking like a wall of text.
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [variantsOpen, setVariantsOpen] = useState(false)
  const [chartHidden, setChartHidden] = useState(false)

  // When usage data arrives (or updates after a save), nudge the picker to the
  // freshly least-used recipe — but only when the user hasn't manually picked
  // something other than the previous default. Practically: only auto-update
  // until the user first renders something.
  useEffect(() => {
    if (result) return // user is mid-flow; don't yank the picker out from under them
    setSelectedRecipe(leastUsedRecipe(dataset, usage))
  }, [usage, dataset, result])

  const renderWith = useCallback(
    async (recipeId: string, seedValue: number, variantOverride?: VariantState) => {
      if (!recipeId) {
        setError("no recipe registered for this dataset")
        return
      }
      setRendering(true)
      setError(null)
      // Only forward variant params for recipes that consume them; passing
      // them to others is harmless but mildly misleading in network logs.
      const params: Record<string, unknown> = {}
      if (VARIANT_AWARE_RECIPES.has(recipeId)) {
        const v = variantOverride ?? variants
        if (v.aggregation_period) params.aggregation_period = v.aggregation_period
        if (v.smoothing)          params.smoothing = v.smoothing
        if (v.normalization)      params.normalization = v.normalization
        if (v.highlight)          params.highlight = v.highlight
      }
      try {
        const r = await sidecar.render({
          recipe_id: recipeId,
          dataset_id: dataset.name,
          seed: seedValue,
          params,
        })
        setResult(r)
        // Stamp the exact controls used for this render so the Re-render
        // button can flag when the user has since drifted off them.
        setLastRendered({
          recipe: recipeId,
          seed: seedValue,
          variants: variantOverride ?? variants,
        })
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setRendering(false)
      }
    },
    [dataset.name, variants]
  )

  // Dirty when controls differ from what was last rendered. Only meaningful
  // after at least one successful render — before that, "Render" is the
  // primary CTA regardless. JSON-stringify variants because two equal-by-
  // value objects aren't === in JS.
  const isDirty =
    lastRendered !== null &&
    (lastRendered.recipe !== selectedRecipe ||
      lastRendered.seed !== seed ||
      JSON.stringify(lastRendered.variants) !== JSON.stringify(variants))

  const doRender = () => renderWith(selectedRecipe, seed)

  const doShuffle = () => {
    // Shuffle should produce a MEANINGFULLY DIFFERENT chart each click, not
    // just a re-coloring. Three independent things change every shuffle:
    //   1. RECIPE — cycle to the next entry in suggested_recipes (wraps).
    //      Previously we picked least-used; when nothing was saved yet, that
    //      was always suggested[0] → same recipe → same chart with new colors.
    //   2. VARIANT PARAMS — for variant-aware recipes, deterministically
    //      cycle through aggregation / smoothing / normalization / highlight
    //      options keyed off shuffleN so consecutive clicks explore new
    //      angles on the same data.
    //   3. STYLE SEED — bumps so theme/palette/marker rotation also changes.
    const nextN = shuffleN + 1
    const nextSeed = 42 + nextN * 17

    const recipes = dataset.suggested_recipes
    const currentIdx = recipes.indexOf(selectedRecipe)
    const nextRecipe =
      recipes.length > 0
        ? recipes[(currentIdx + 1) % recipes.length]
        : selectedRecipe

    let nextVariants: VariantState = {}
    if (VARIANT_AWARE_RECIPES.has(nextRecipe)) {
      const pick = (offset: number, opts: string[]) =>
        opts[(nextN + offset) % opts.length]
      nextVariants = {
        aggregation_period: pick(0, ["monthly", "quarterly", "yearly", "weekly", "daily"]),
        smoothing: pick(1, ["raw", "rolling_3", "rolling_12"]),
        normalization: pick(2, ["absolute", "pct_change", "index_100", "z_score"]),
        highlight: pick(3, ["none", "max_point", "min_point"]),
      }
    }

    setShuffleN(nextN)
    setSeed(nextSeed)
    setSelectedRecipe(nextRecipe)
    setVariants(nextVariants)
    renderWith(nextRecipe, nextSeed, nextVariants)
  }

  const onRecipeChange = (next: string) => {
    setSelectedRecipe(next)
    // Variant state is per-recipe semantically; clear when switching so a
    // "monthly aggregation" pick on a line chart doesn't silently follow the
    // user into a treemap that ignores it.
    setVariants({})
  }

  const showVariants = VARIANT_AWARE_RECIPES.has(selectedRecipe)

  // Per-recipe usage counts for this dataset — surfaced in the picker label
  // so the author sees at a glance which combinations are under-explored.
  const recipeCount = (recipeId: string): number => {
    if (!usage) return 0
    const row = usage.by_pair.find(
      (p) => p.dataset_name === dataset.name && p.recipe_id === recipeId
    )
    return row?.count ?? 0
  }

  // Active-variant count — surfaced in the collapsed Variants pill so the
  // author sees at a glance whether transforms are in play.
  const VARIANT_DEFAULTS: Record<string, string> = {
    aggregation_period: "monthly",
    smoothing: "raw",
    normalization: "absolute",
    highlight: "none",
  }
  const activeVariantCount = Object.entries(variants).reduce(
    (n, [k, v]) => n + (v && v !== VARIANT_DEFAULTS[k] ? 1 : 0),
    0
  )

  // ── Compact (inactive) card ────────────────────────────────────────────
  if (!isActive) {
    const savedCount = usage?.by_dataset[dataset.name] ?? 0
    const nRecipes = dataset.suggested_recipes.length
    return (
      <article
        id={`dataset-card-${dataset.name}`}
        className="group flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 scroll-mt-4 hover:border-foreground/30 hover:bg-muted/30 transition-colors"
      >
        <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
          <Database className="size-3.5 text-muted-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-medium">{dataset.name}</span>
            <span className="rounded-full border border-emerald-500/40 px-1.5 py-0.5 text-[10px] font-medium text-emerald-500">
              {dataset.license}
            </span>
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {dataset.domain}
            </span>
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {nRecipes} recipe{nRecipes === 1 ? "" : "s"}
            </span>
            {savedCount > 0 && (
              <span className="rounded-full border border-blue-500/40 bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-500">
                {savedCount} saved
              </span>
            )}
            {result && (
              <span className="rounded-full border border-foreground/20 bg-foreground/5 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                in-progress
              </span>
            )}
          </div>
        </div>
        <button
          onClick={onOpen}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1 text-xs hover:bg-muted"
        >
          Open
          <ChevronRight className="size-3.5" />
        </button>
      </article>
    )
  }

  // ── Expanded (active) card ────────────────────────────────────────────
  const savedCount = usage?.by_dataset[dataset.name] ?? 0
  const candidateCount = ideationDrafts.length
  const precheckOk = latestPrecheck?.submittable
  const precheckRan = latestPrecheck !== null
  const tabs: { id: WorkTab; label: string; icon: typeof Calculator; badge?: React.ReactNode; disabled?: boolean }[] = [
    { id: "chart", label: "Chart", icon: ImageIcon, disabled: !result },
    {
      id: "compute",
      label: "Compute",
      icon: Calculator,
      badge: result ? <span className="rounded-full bg-muted px-1 text-[9px]">{result.records.length}</span> : null,
      disabled: !result,
    },
    {
      id: "brainstorm",
      label: "Brainstorm",
      icon: Lightbulb,
      badge: candidateCount > 0 ? <span className="rounded-full bg-foreground/10 px-1 text-[9px]">{candidateCount}</span> : null,
      disabled: !result,
    },
    {
      id: "precheck",
      label: "Pre-check",
      icon: ShieldCheck,
      badge: precheckRan ? (
        precheckOk
          ? <CheckCircle2 className="size-3 text-emerald-500" />
          : <AlertTriangle className="size-3 text-amber-500" />
      ) : null,
      disabled: !result,
    },
    { id: "assemble", label: "Assemble", icon: FileText, disabled: !result },
  ]

  return (
    <article
      id={`dataset-card-${dataset.name}`}
      className="rounded-xl border border-foreground/20 bg-card shadow-sm scroll-mt-4"
    >
      {/* Header — minimal by default, with collapsible Details */}
      <header className="flex items-start gap-3 border-b border-border p-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
          <Database className="size-4 text-muted-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="text-sm font-semibold">{dataset.name}</h3>
            <span className="rounded-full border border-emerald-500/40 px-1.5 py-0.5 text-[10px] font-medium text-emerald-500">
              {dataset.license}
            </span>
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {dataset.domain}
            </span>
            {savedCount > 0 && (
              <span className="rounded-full border border-blue-500/40 bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-500">
                {savedCount} saved
              </span>
            )}
            <button
              onClick={() => setDetailsOpen((v) => !v)}
              className="ml-1 inline-flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground"
              title="Show description + columns + source"
            >
              {detailsOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
              Details
            </button>
          </div>
          {detailsOpen && (
            <div className="mt-2 space-y-1 text-[11px] text-muted-foreground">
              <p>{dataset.description}</p>
              <p>
                Columns:{" "}
                <span className="font-mono">
                  {dataset.columns_schema.map((c) => c.name).join(", ")}
                </span>
              </p>
              <a
                href={dataset.source_url}
                target="_blank"
                rel="noreferrer"
                className="text-[10px] text-blue-500 hover:underline break-all"
              >
                {dataset.source_url}
              </a>
            </div>
          )}
        </div>
        <button
          onClick={onClose}
          title="Collapse dataset"
          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </header>

      {/* Controls row — Render / Shuffle / Seed / Recipe */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
        <button
          disabled={rendering}
          onClick={() => {
            doRender()
            setTab("chart")
          }}
          title={
            isDirty
              ? "Controls changed since last render — click to apply"
              : result
                ? "Re-render with current controls"
                : "Render the chart for the selected recipe + seed"
          }
          className={`relative inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-50 ${
            isDirty
              ? "bg-amber-500 text-black hover:bg-amber-400"
              : "bg-foreground text-background hover:bg-foreground/90"
          }`}
        >
          {rendering ? (
            <>
              <Loader2 className="size-3.5 animate-spin" />
              Rendering…
            </>
          ) : result ? (
            <>
              <RefreshCw className="size-3.5" />
              {isDirty ? "Re-render (apply changes)" : "Re-render"}
            </>
          ) : (
            <>
              <ImageIcon className="size-3.5" />
              Render chart
            </>
          )}
          {isDirty && !rendering && (
            <span className="absolute -right-1 -top-1 size-2 rounded-full bg-amber-500 ring-2 ring-card" />
          )}
        </button>
        <button
          disabled={rendering || !dataset.suggested_recipes.length}
          onClick={() => {
            doShuffle()
            setTab("chart")
          }}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
          title="New seed + least-used recipe, then render"
        >
          <Shuffle className="size-3.5" />
          Shuffle
        </button>
        <label
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
          title="Style seed — rotates the chart's theme, color palette, and marker-shape choices. Does NOT change the underlying data. Click Re-render to apply."
        >
          Seed
          <input
            type="number"
            value={seed}
            onChange={(e) => setSeed(parseInt(e.target.value || "0", 10))}
            title="Style seed only — changes theme/palette/marker rotation. The dataset values shown on the chart are not affected."
            className="h-7 w-16 rounded-md border border-border bg-background px-2 text-xs"
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Recipe
          <select
            value={selectedRecipe}
            onChange={(e) => onRecipeChange(e.target.value)}
            disabled={!dataset.suggested_recipes.length}
            className="h-7 max-w-[22rem] rounded-md border border-border bg-background px-2 text-xs font-mono"
          >
            {dataset.suggested_recipes.length === 0 && (
              <option value="">—</option>
            )}
            {dataset.suggested_recipes.map((r) => (
              <option key={r} value={r}>
                {r} ({recipeCount(r)} used)
              </option>
            ))}
          </select>
        </label>
        {showVariants && (
          <button
            onClick={() => setVariantsOpen((v) => !v)}
            className={`ml-auto inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-muted ${
              activeVariantCount > 0
                ? "border-foreground/30 bg-foreground/5"
                : "border-border bg-background text-muted-foreground"
            }`}
            title="Toggle aggregation / smoothing / normalization / highlight chips"
          >
            <Sliders className="size-3" />
            Variants
            {activeVariantCount > 0 && (
              <span className="rounded-full bg-foreground/10 px-1 text-[9px]">{activeVariantCount}</span>
            )}
            {variantsOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          </button>
        )}
      </div>

      {/* Variants panel — collapsed by default */}
      {showVariants && variantsOpen && (
        <div className="border-b border-border p-3">
          <VariantChips value={variants} onChange={setVariants} />
        </div>
      )}

      {/* Render error banner */}
      {error && (
        <div className="m-3 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs">
          <AlertTriangle className="mt-0.5 size-3.5 text-amber-500" />
          <div className="text-muted-foreground break-words">{error}</div>
        </div>
      )}

      {/* Tabs — only shown once we have a render result */}
      {result && (
        <>
          <nav className="flex flex-wrap items-center gap-0.5 border-b border-border bg-muted/20 px-2 py-1">
            {tabs.map((t) => {
              const active = tab === t.id
              return (
                <button
                  key={t.id}
                  onClick={() => !t.disabled && setTab(t.id)}
                  disabled={t.disabled}
                  className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors ${
                    active
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  } ${t.disabled ? "opacity-40 cursor-not-allowed" : ""}`}
                >
                  <t.icon className="size-3.5" />
                  {t.label}
                  {t.badge}
                </button>
              )
            })}
          </nav>

          <div className="p-3">
            {/* All panels are MOUNTED in parallel and toggled via `hidden` —
               this preserves their internal state (candidates, expressions,
               precheck reports, form fields) when the user switches tabs.
               Each panel takes the chart `fingerprint` as part of its key so
               it auto-resets when the underlying chart actually changes
               (re-render with different recipe / seed / variants), but NOT
               on a pure tab switch. */}

            {/* CHART TAB */}
            <div hidden={tab !== "chart"} className="space-y-2">
              <button
                onClick={() => setChartHidden((h) => !h)}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-[11px] hover:bg-muted"
              >
                {chartHidden ? <Eye className="size-3" /> : <EyeOff className="size-3" />}
                {chartHidden ? "Show chart" : "Hide chart"}
              </button>
              {!chartHidden && <ChartViewer result={result} />}
              {chartHidden && (
                <div className="rounded-md border border-dashed border-border bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
                  Chart hidden ·{" "}
                  <span className="font-mono">{result.metadata.recipe_id}</span>{" "}
                  fingerprint{" "}
                  <span className="font-mono">{result.metadata.fingerprint.slice(0, 8)}</span>
                </div>
              )}
            </div>

            {/* COMPUTE TAB */}
            <div hidden={tab !== "compute"}>
              <ComputePane
                key={`compute-${result.metadata.fingerprint}-${computeKey}`}
                records={result.records}
                initialExpression={computeExpr}
              />
            </div>

            {/* BRAINSTORM TAB — auto-switches to Compute / Pre-check on send.
               key intentionally OMITS the tab + computeKey/precheckKey so the
               candidate list survives tab switches and "send" actions. */}
            <div hidden={tab !== "brainstorm"}>
              <IdeationPanel
                key={`ideation-${result.metadata.fingerprint}`}
                renderResult={result}
                datasetName={dataset.name}
                datasetDescription={dataset.description}
                onUseInCompute={(expr) => {
                  setComputeExpr(expr)
                  setComputeKey((k) => k + 1)
                  setTab("compute")
                }}
                onSendToPrecheck={(q) => {
                  setPrecheckSeed(q)
                  setPrecheckKey((k) => k + 1)
                  setTab("precheck")
                }}
                onCandidates={setIdeationDrafts}
              />
            </div>

            {/* PRE-CHECK TAB */}
            <div hidden={tab !== "precheck"}>
              <PreCheckPanel
                key={`precheck-${result.metadata.fingerprint}-${precheckKey}`}
                imageB64={result.png_b64}
                initial={precheckSeed}
                onReport={setLatestPrecheck}
              />
            </div>

            {/* ASSEMBLE TAB */}
            <div hidden={tab !== "assemble"}>
              <TaskAssemblyPanel
                key={`assemble-${result.metadata.fingerprint}`}
                renderResult={result}
                datasetName={dataset.name}
                ideationDrafts={ideationDrafts}
                seed={precheckSeed}
                latestPrecheck={latestPrecheck}
                onSaved={onTaskSaved}
              />
            </div>
          </div>
        </>
      )}
    </article>
  )
}
