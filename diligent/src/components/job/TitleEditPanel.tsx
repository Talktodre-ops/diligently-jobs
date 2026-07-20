import { useEffect, useState } from "react";
import { Input } from "@/components/ui";

interface TitleEditPanelProps {
  title: string;
  onChange: (title: string) => void;
}

/**
 * Inline editor for the headline/job title shown under the candidate's name.
 * Local draft while typing, committed on blur so the export's tailored variant
 * doc picks it up. Mirrors SummaryEditPanel's draft/commit pattern.
 */
export const TitleEditPanel = ({ title, onChange }: TitleEditPanelProps) => {
  const [draft, setDraft] = useState(title);

  // Resync when a new headline is generated upstream.
  useEffect(() => {
    setDraft(title);
  }, [title]);

  return (
    <div className="flex flex-col gap-2 mt-2 pt-3 border-t border-input/40">
      <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
        Job title (editable)
      </span>
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => onChange(draft.trim())}
        placeholder="e.g. Senior Frontend Engineer"
        className="h-8 text-xs"
      />
      <p className="text-[11px] text-muted-foreground">
        Shown under your name on the exported CV.
      </p>
    </div>
  );
};
