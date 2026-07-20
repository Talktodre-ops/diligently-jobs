import { useEffect, useState } from "react";
import { Loader2, PenLine } from "lucide-react";
import { Button, Input, Textarea } from "@/components/ui";
import { CoverLetterExportPanel } from "./CoverLetterExportPanel";
import type { CoverLetter, CoverLetterDoc } from "@/types";

interface CoverLetterPanelProps {
  coverLetter: CoverLetter | null;
  isGenerating: boolean;
  hasRequirements: boolean;
  hasResearch: boolean;
  streamStatus: string;
  applicationId?: string;
  onGenerate: () => void;
  onDocChange: (doc: CoverLetterDoc) => void;
}

export const CoverLetterPanel = ({
  coverLetter,
  isGenerating,
  hasRequirements,
  hasResearch,
  streamStatus,
  applicationId,
  onGenerate,
  onDocChange,
}: CoverLetterPanelProps) => {
  const doc = coverLetter?.doc ?? null;
  const [greetingDraft, setGreetingDraft] = useState(doc?.greeting ?? "");
  const [bodyDraft, setBodyDraft] = useState((doc?.paragraphs ?? []).join("\n\n"));

  useEffect(() => {
    setGreetingDraft(doc?.greeting ?? "");
    setBodyDraft((doc?.paragraphs ?? []).join("\n\n"));
  }, [doc]);

  const commitGreeting = () => {
    if (!doc) return;
    onDocChange({ ...doc, greeting: greetingDraft.trim() || null });
  };
  const commitBody = () => {
    if (!doc) return;
    onDocChange({
      ...doc,
      paragraphs: bodyDraft
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter(Boolean),
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        A specific, AIDA-structured cover letter — its opening hook comes from
        your <strong>company research</strong>, its proof from your{" "}
        <strong>tailored CV</strong>. Edit freely, then export to PDF/DOCX.
      </p>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={onGenerate}
          disabled={isGenerating || !hasRequirements}
          className="text-xs"
        >
          {isGenerating ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              Writing…
            </>
          ) : (
            <>
              <PenLine className="h-3 w-3" />
              {coverLetter ? "Re-generate" : "Generate cover letter"}
            </>
          )}
        </Button>
        {!hasRequirements ? (
          <span className="text-xs text-amber-600">Parse the JD first (tab 1).</span>
        ) : !hasResearch ? (
          <span className="text-xs text-muted-foreground">
            Tip: run Research (tab 2) first for company-specific hooks.
          </span>
        ) : null}
      </div>

      {isGenerating && streamStatus && (
        <p className="text-xs text-muted-foreground line-clamp-3">{streamStatus}</p>
      )}

      {doc && (
        <div className="flex flex-col gap-3 rounded-xl border border-input/50 p-3">
          <div className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Greeting
            </span>
            <Input
              value={greetingDraft}
              onChange={(e) => setGreetingDraft(e.target.value)}
              onBlur={commitGreeting}
              className="h-7 text-xs"
              placeholder="Dear Hiring Manager,"
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Body (paragraphs separated by a blank line)
            </span>
            <Textarea
              value={bodyDraft}
              onChange={(e) => setBodyDraft(e.target.value)}
              onBlur={commitBody}
              className="min-h-0 resize-none text-xs py-1.5 leading-relaxed"
              rows={16}
              placeholder="Cover letter body…"
            />
          </div>
          <p className="text-[11px] text-muted-foreground">
            Header ({doc.candidate_name}
            {doc.candidate_contact ? ` · ${doc.candidate_contact}` : ""}), date,
            and sign-off ({doc.signoff}) are added automatically on export.
          </p>

          <CoverLetterExportPanel
            doc={doc}
            sources={coverLetter?.sources ?? []}
            applicationId={applicationId}
          />
        </div>
      )}
    </div>
  );
};
