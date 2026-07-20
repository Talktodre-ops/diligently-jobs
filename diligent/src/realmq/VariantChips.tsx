import { Sliders } from "lucide-react"

/** A "variant axis" multiplies a base recipe into many distinct chart outputs
 *  by transforming the data (aggregation/smoothing/normalization) or the
 *  rendering (highlight). The backend's apply_variant_transforms() in
 *  recipes.py reads these param names and applies them no-op-when-default,
 *  so we always pass the user's selection through. */
export interface VariantState {
  aggregation_period?: string
  smoothing?: string
  normalization?: string
  highlight?: string
}

interface AxisDef {
  label: string
  param: keyof VariantState
  options: { value: string; label: string }[]
  /** The value that means "no transform" — used to mark a default pill. */
  defaultValue: string
}

const AXES: AxisDef[] = [
  {
    label: "Aggregation",
    param: "aggregation_period",
    defaultValue: "monthly",
    options: [
      { value: "daily",     label: "Daily" },
      { value: "weekly",    label: "Weekly" },
      { value: "monthly",   label: "Monthly" },
      { value: "quarterly", label: "Quarterly" },
      { value: "yearly",    label: "Yearly" },
    ],
  },
  {
    label: "Smoothing",
    param: "smoothing",
    defaultValue: "raw",
    options: [
      { value: "raw",        label: "Raw" },
      { value: "rolling_3",  label: "Rolling 3" },
      { value: "rolling_12", label: "Rolling 12" },
    ],
  },
  {
    label: "Normalize",
    param: "normalization",
    defaultValue: "absolute",
    options: [
      { value: "absolute",   label: "Absolute" },
      { value: "pct_change", label: "Δ %" },
      { value: "index_100",  label: "Index 100" },
      { value: "z_score",    label: "Z-score" },
    ],
  },
  {
    label: "Highlight",
    param: "highlight",
    defaultValue: "none",
    options: [
      { value: "none",      label: "None" },
      { value: "max_point", label: "Max point" },
      { value: "min_point", label: "Min point" },
    ],
  },
]

interface Props {
  value: VariantState
  onChange: (next: VariantState) => void
  /** Set when at least one variant deviates from its default — for the badge. */
  changedCount?: number
}

export function VariantChips({ value, onChange }: Props) {
  const changedCount = AXES.reduce(
    (n, ax) =>
      n + (value[ax.param] && value[ax.param] !== ax.defaultValue ? 1 : 0),
    0
  )

  const reset = () => {
    onChange({})
  }

  return (
    <div className="rounded-md border border-border bg-muted/20 p-3">
      <div className="mb-2 flex items-center gap-2">
        <Sliders className="size-3.5 text-muted-foreground" />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Variants
        </span>
        {changedCount > 0 && (
          <span className="rounded-full bg-foreground/10 px-1.5 py-0.5 text-[10px] font-medium">
            {changedCount} transform{changedCount === 1 ? "" : "s"} active
          </span>
        )}
        <span className="text-[10px] text-muted-foreground">
          · each combination produces a distinct chart; click Re-render to apply
        </span>
        {changedCount > 0 && (
          <button
            onClick={reset}
            className="ml-auto rounded border border-border bg-background px-1.5 py-0.5 text-[10px] hover:bg-muted"
          >
            Reset
          </button>
        )}
      </div>
      <div className="space-y-1.5">
        {AXES.map((ax) => {
          const selected = value[ax.param] ?? ax.defaultValue
          return (
            <div key={ax.param} className="flex flex-wrap items-center gap-1.5">
              <span className="w-20 shrink-0 text-[10px] text-muted-foreground">
                {ax.label}
              </span>
              {ax.options.map((opt) => {
                const isActive = selected === opt.value
                const isDefault = opt.value === ax.defaultValue
                return (
                  <button
                    key={opt.value}
                    onClick={() =>
                      onChange({ ...value, [ax.param]: opt.value })
                    }
                    className={
                      isActive
                        ? "rounded-full bg-foreground px-2 py-0.5 text-[10px] font-medium text-background"
                        : isDefault
                          ? "rounded-full border border-dashed border-border bg-background px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-muted"
                          : "rounded-full border border-border bg-background px-2 py-0.5 text-[10px] hover:bg-muted"
                    }
                    title={isDefault ? "Default — no transform" : opt.value}
                  >
                    {opt.label}
                  </button>
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Recipes whose render fn calls apply_variant_transforms() in recipes.py.
 *  Other recipes ignore variant params; hide the chips for them to avoid
 *  implying the controls do anything. */
export const VARIANT_AWARE_RECIPES = new Set<string>([
  "line_with_confidence_band",
  "small_multiples_line",
  "calendar_heatmap",
  "stacked_area_share",
])
