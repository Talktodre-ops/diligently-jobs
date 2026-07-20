import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui";
import type { ApplicationStage } from "@/types";

interface PipelineBarProps {
  stage: ApplicationStage;
  isBuildingKit: boolean;
  hasRequirements: boolean;
  onBuildKit: () => void;
  onSetStage: (s: ApplicationStage) => void;
}

const STAGES: { value: ApplicationStage; label: string }[] = [
  { value: "draft", label: "Draft" },
  { value: "researched", label: "Researched" },
  { value: "tailored", label: "Tailored" },
  { value: "letter_ready", label: "Letter ready" },
  { value: "submitted", label: "Submitted" },
  { value: "following_up", label: "Following up" },
  { value: "interviewing", label: "Interviewing" },
  { value: "closed", label: "Closed" },
];

/**
 * Cohesion bar (Phase 3, M4): a one-click "Application Kit" (research → cover
 * letter → follow-ups) plus the application's pipeline stage. Shown above the
 * tab content so it's visible throughout the workflow.
 */
export const PipelineBar = ({
  stage,
  isBuildingKit,
  hasRequirements,
  onBuildKit,
  onSetStage,
}: PipelineBarProps) => {
  return (
    <div className="mb-3 flex items-center justify-between gap-2 flex-wrap rounded-xl border border-input/40 bg-muted/20 px-3 py-2">
      <Button
        size="sm"
        onClick={onBuildKit}
        disabled={isBuildingKit || !hasRequirements}
        className="text-xs"
        title="Run research, cover letter, and follow-ups in one go"
      >
        {isBuildingKit ? (
          <>
            <Loader2 className="h-3 w-3 animate-spin" />
            Building kit…
          </>
        ) : (
          <>
            <Sparkles className="h-3 w-3" />
            Generate Application Kit
          </>
        )}
      </Button>

      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        Stage
        <select
          value={stage}
          onChange={(e) => onSetStage(e.target.value as ApplicationStage)}
          className="h-7 rounded-md border border-input/50 bg-background px-2 text-xs focus:border-primary/50 outline-none"
        >
          {STAGES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
};
