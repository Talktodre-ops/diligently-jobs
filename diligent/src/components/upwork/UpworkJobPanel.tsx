import { useEffect, useState } from "react";
import { Loader2, CheckSquare, Square } from "lucide-react";
import { Button, Textarea } from "@/components/ui";
import type { JobRequirements } from "@/types";

interface UpworkJobPanelProps {
  jdText: string;
  setJDText: (text: string) => void;
  angle: string;
  onAngleChange: (text: string) => void;
  useCv: boolean;
  onUseCvChange: (value: boolean) => void;
  requirements?: JobRequirements;
  isParsing: boolean;
  onParse: () => void;
}

export const UpworkJobPanel = ({
  jdText,
  setJDText,
  angle,
  onAngleChange,
  useCv,
  onUseCvChange,
  requirements,
  isParsing,
  onParse,
}: UpworkJobPanelProps) => {
  const words = jdText.trim() ? jdText.trim().split(/\s+/).length : 0;
  const chars = jdText.length;

  const [angleDraft, setAngleDraft] = useState(angle);
  useEffect(() => setAngleDraft(angle), [angle]);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Paste the Upwork job post. We'll pull out the skills + keywords, then use
        them to find related open-source projects and write a proposal whose{" "}
        <strong>first line is specific to this gig</strong> — not generic.
      </p>

      {requirements && (
        <div className="flex items-center gap-2 pb-1 border-b border-input/50">
          <span className="text-sm font-semibold">
            {requirements.role || "Untitled gig"}
          </span>
        </div>
      )}

      <Textarea
        value={jdText}
        onChange={(e) => setJDText(e.target.value)}
        placeholder="Paste the full Upwork job description here…"
        className="min-h-40 max-h-64 resize-none text-xs leading-relaxed"
        disabled={isParsing}
      />

      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {chars > 0 ? `${words} words · ${chars} chars` : ""}
        </span>
        <Button
          size="sm"
          variant={requirements ? "outline" : "default"}
          onClick={onParse}
          disabled={isParsing || !jdText.trim()}
        >
          {isParsing ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              Parsing…
            </>
          ) : requirements ? (
            "Re-parse post"
          ) : (
            "Parse post"
          )}
        </Button>
      </div>

      {/* Whether to ground the proposal in the saved base CV. */}
      <button
        type="button"
        onClick={() => onUseCvChange(!useCv)}
        className="flex items-center gap-2 text-xs text-left rounded-lg border border-input/50 px-3 py-2 hover:bg-accent/40 transition-colors"
      >
        {useCv ? (
          <CheckSquare className="h-4 w-4 text-primary shrink-0" />
        ) : (
          <Square className="h-4 w-4 text-muted-foreground shrink-0" />
        )}
        <span>
          <span className="font-semibold">Use my saved CV as proof</span>
          <span className="text-muted-foreground">
            {" "}
            — {useCv
              ? "on: grounds the proposal in your real experience."
              : "off: writes from the job + approach alone (good when your CV isn't relevant to this gig)."}
          </span>
        </span>
      </button>

      {/* Optional angle / context the proposal should lean on. */}
      <div className="flex flex-col gap-1.5 rounded-xl border border-input/50 p-3">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Your angle (optional)
        </span>
        <p className="text-[11px] text-muted-foreground">
          Anything specific you want emphasised — a related project you've built,
          a transferable strength, your availability, or how you'd approach it.
          Used to ground the proposal (never fabricated).
        </p>
        <Textarea
          value={angleDraft}
          onChange={(e) => setAngleDraft(e.target.value)}
          onBlur={() => onAngleChange(angleDraft)}
          placeholder="e.g. I've built a similar realtime dashboard with Next.js + WebSockets; can start this week."
          className="min-h-0 resize-none text-xs py-1.5"
          rows={3}
        />
      </div>

      {requirements && (
        <div className="flex flex-col gap-2 rounded-xl border border-input/50 p-3">
          {requirements.required.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-semibold">Required</span>
              <div className="flex flex-wrap gap-1">
                {requirements.required.map((r, i) => (
                  <span
                    key={i}
                    className="rounded-md bg-accent px-1.5 py-0.5 text-[11px]"
                  >
                    {r}
                  </span>
                ))}
              </div>
            </div>
          )}
          {requirements.keywords.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-semibold">Keywords</span>
              <div className="flex flex-wrap gap-1">
                {requirements.keywords.map((k, i) => (
                  <span
                    key={i}
                    className="rounded-md border border-input/60 px-1.5 py-0.5 text-[11px] text-muted-foreground"
                  >
                    {k}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
