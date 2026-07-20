import { Loader2 } from "lucide-react";
import { Button, Textarea } from "@/components/ui";
import type { JobRequirements } from "@/types";

interface JDInputPanelProps {
  jdText: string;
  setJDText: (text: string) => void;
  requirements?: JobRequirements;
  isParsingJD: boolean;
  streamStatus: string;
  onParse: () => void;
}

export const JDInputPanel = ({
  jdText,
  setJDText,
  requirements,
  isParsingJD,
  onParse,
}: JDInputPanelProps) => {
  const words = jdText.trim() ? jdText.trim().split(/\s+/).length : 0;
  const chars = jdText.length;

  return (
    <div className="flex flex-col gap-3">
      {requirements && (
        <div className="flex items-center gap-2 pb-1 border-b border-input/50">
          <span className="text-sm font-semibold">{requirements.role}</span>
          {requirements.company && (
            <>
              <span className="text-muted-foreground text-xs">@</span>
              <span className="text-sm text-muted-foreground">{requirements.company}</span>
            </>
          )}
        </div>
      )}

      <Textarea
        value={jdText}
        onChange={(e) => setJDText(e.target.value)}
        placeholder="Paste the full job description here…"
        className="min-h-40 max-h-64 resize-none text-xs leading-relaxed"
        disabled={isParsingJD}
      />

      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {chars > 0 ? `${words} words · ${chars} chars` : ""}
        </span>
        <Button
          size="sm"
          variant={requirements ? "outline" : "default"}
          onClick={onParse}
          disabled={isParsingJD || !jdText.trim()}
        >
          {isParsingJD ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              Parsing…
            </>
          ) : requirements ? (
            "Re-parse JD"
          ) : (
            "Parse JD"
          )}
        </Button>
      </div>
    </div>
  );
};
