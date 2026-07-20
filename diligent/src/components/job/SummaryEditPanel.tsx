import { useEffect, useState } from "react";
import { Textarea } from "@/components/ui";

interface SummaryEditPanelProps {
  summary: string;
  onChange: (summary: string) => void;
}

/**
 * Inline editor for the regenerated professional summary. Edited as a local
 * draft so typing feels natural; committed on blur via onChange → the export's
 * tailored variant doc reflects it. Mirrors TailoredSkillsPanel's draft/commit
 * pattern.
 */
export const SummaryEditPanel = ({ summary, onChange }: SummaryEditPanelProps) => {
  const [draft, setDraft] = useState(summary);

  // Resync when a new summary is generated upstream.
  useEffect(() => {
    setDraft(summary);
  }, [summary]);

  return (
    <div className="flex flex-col gap-2 mt-2 pt-3 border-t border-input/40">
      <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
        Tailored summary (editable)
      </span>
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => onChange(draft.trim())}
        placeholder="Tailored professional summary…"
        className="min-h-0 resize-none text-xs py-1.5 leading-relaxed"
        rows={5}
      />
    </div>
  );
};
