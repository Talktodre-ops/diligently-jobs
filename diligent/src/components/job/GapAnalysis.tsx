import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui";
import type { Gap } from "@/types";

interface GapAnalysisProps {
  gaps: Gap[];
  isAnalyzing: boolean;
  hasRequirements: boolean;
  hasCv: boolean;
  onAnalyze: () => void;
}

const STATUS_CONFIG = {
  covered: { label: "Covered", icon: "✅", className: "border-green-500/30 bg-green-500/5" },
  partial: { label: "Partial", icon: "⚠️", className: "border-yellow-500/30 bg-yellow-500/5" },
  missing: { label: "Missing", icon: "❌", className: "border-red-500/30 bg-red-500/5" },
} as const;

const GapRow = ({ gap }: { gap: Gap }) => {
  const cfg = STATUS_CONFIG[gap.status];
  return (
    <div className={`rounded-lg border p-2 ${cfg.className}`}>
      <div className="flex items-start gap-2">
        <span className="text-sm shrink-0 mt-0.5">{cfg.icon}</span>
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="text-xs font-medium leading-snug">{gap.requirement}</span>
          {gap.cv_match && (
            <span className="text-xs text-muted-foreground truncate" title={gap.cv_match}>
              → {gap.cv_match}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};

export const GapAnalysis = ({
  gaps,
  isAnalyzing,
  hasRequirements,
  hasCv,
  onAnalyze,
}: GapAnalysisProps) => {
  const covered = gaps.filter((g) => g.status === "covered");
  const partial = gaps.filter((g) => g.status === "partial");
  const missing = gaps.filter((g) => g.status === "missing");
  const total = gaps.length;

  return (
    <div className="flex flex-col gap-3">
      {total > 0 && (
        <div className="flex items-center gap-2 rounded-xl border border-input/50 bg-muted/30 px-3 py-2">
          <span className="text-xs font-medium">
            {covered.length + partial.length} of {total} requirements addressed
          </span>
          <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-green-500/70 rounded-full transition-all"
              style={{ width: `${((covered.length + partial.length) / total) * 100}%` }}
            />
          </div>
        </div>
      )}

      {gaps.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">
          {hasRequirements && hasCv
            ? "Run gap analysis to see results."
            : !hasRequirements
            ? "Parse a JD first."
            : "Add CV bullets first."}
        </p>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          {[
            { key: "covered" as const, items: covered },
            { key: "partial" as const, items: partial },
            { key: "missing" as const, items: missing },
          ].map(({ key, items }) => (
            <div key={key} className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                {STATUS_CONFIG[key].icon} {STATUS_CONFIG[key].label} ({items.length})
              </span>
              {items.map((gap, i) => (
                <GapRow key={i} gap={gap} />
              ))}
            </div>
          ))}
        </div>
      )}

      <Button
        size="sm"
        onClick={onAnalyze}
        disabled={isAnalyzing || !hasRequirements || !hasCv}
        className="self-end"
      >
        {isAnalyzing ? (
          <>
            <Loader2 className="h-3 w-3 animate-spin" />
            Analyzing…
          </>
        ) : (
          "Analyze gaps"
        )}
      </Button>
    </div>
  );
};
