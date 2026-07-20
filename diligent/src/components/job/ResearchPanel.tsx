import { useEffect, useState } from "react";
import { Loader2, Search, ExternalLink } from "lucide-react";
import { Button, Textarea } from "@/components/ui";
import type { CompanyBrief, CompanyResearch } from "@/types";

interface ResearchPanelProps {
  research: CompanyResearch | null;
  /** Persisted paste box content (LinkedIn post / news Brave can't fetch). */
  paste: string;
  isResearching: boolean;
  /** Company name parsed from the JD — research works best with it. */
  company?: string;
  streamStatus: string;
  onRun: () => void;
  onPasteChange: (text: string) => void;
  onBriefChange: (brief: CompanyBrief) => void;
}

/** Read-only labeled list block. */
const ListBlock = ({ label, items }: { label: string; items: string[] }) =>
  items.length > 0 ? (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-semibold">{label}</span>
      <ul className="flex flex-col gap-0.5 pl-3">
        {items.map((it, i) => (
          <li key={i} className="text-xs text-foreground/80 list-disc">
            {it}
          </li>
        ))}
      </ul>
    </div>
  ) : null;

export const ResearchPanel = ({
  research,
  paste,
  isResearching,
  company,
  streamStatus,
  onRun,
  onPasteChange,
  onBriefChange,
}: ResearchPanelProps) => {
  const [pasteDraft, setPasteDraft] = useState(paste);
  const brief = research?.brief ?? null;

  // Editable drafts for the two cover-letter-critical fields.
  const [whyDraft, setWhyDraft] = useState(brief?.why_them ?? "");
  const [pointsDraft, setPointsDraft] = useState(
    (brief?.talking_points ?? []).join("\n")
  );

  useEffect(() => setPasteDraft(paste), [paste]);
  useEffect(() => {
    setWhyDraft(brief?.why_them ?? "");
    setPointsDraft((brief?.talking_points ?? []).join("\n"));
  }, [brief]);

  const commitWhy = () => {
    if (!brief) return;
    onBriefChange({ ...brief, why_them: whyDraft.trim() || null });
  };
  const commitPoints = () => {
    if (!brief) return;
    onBriefChange({
      ...brief,
      talking_points: pointsDraft
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        Research the company from the web to ground your cover letter and
        interview prep in real, specific facts — not generic flattery. The{" "}
        <strong>why-them</strong> and <strong>talking points</strong> below feed
        the cover letter.
      </p>

      {/* Run row */}
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={onRun} disabled={isResearching} className="text-xs">
          {isResearching ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              Researching…
            </>
          ) : (
            <>
              <Search className="h-3 w-3" />
              {research ? "Re-run research" : "Research company"}
            </>
          )}
        </Button>
        {company ? (
          <span className="text-xs text-muted-foreground truncate">
            Target: {company}
          </span>
        ) : (
          <span className="text-xs text-amber-600">
            Parse the JD first (or paste content below) to set a company.
          </span>
        )}
      </div>

      {isResearching && streamStatus && (
        <p className="text-xs text-muted-foreground line-clamp-2">{streamStatus}</p>
      )}

      {/* Paste-assist — for content Brave can't fetch (e.g. LinkedIn posts). */}
      <div className="flex flex-col gap-1.5 rounded-xl border border-input/50 p-3">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Paste content (optional)
        </span>
        <p className="text-[11px] text-muted-foreground">
          Found a LinkedIn post, recent announcement, or careers-page text you
          want referenced? Paste it here — it's treated as a high-priority,
          citable source. (Web search can't fetch login-gated pages like
          LinkedIn.)
        </p>
        <Textarea
          value={pasteDraft}
          onChange={(e) => setPasteDraft(e.target.value)}
          onBlur={() => onPasteChange(pasteDraft)}
          placeholder="Paste a post / article / page text…"
          className="min-h-0 resize-none text-xs py-1.5"
          rows={4}
        />
      </div>

      {/* Brief */}
      {brief && (
        <div className="flex flex-col gap-3 rounded-xl border border-input/50 p-3">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Company brief
          </span>

          {brief.mission && (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-semibold">Mission</span>
              <p className="text-xs text-foreground/80">{brief.mission}</p>
            </div>
          )}

          <ListBlock label="Products" items={brief.products} />
          <ListBlock label="Tech stack" items={brief.tech_stack} />
          <ListBlock label="Recent news" items={brief.recent_news} />
          <ListBlock label="Culture signals" items={brief.culture} />

          {/* Editable — these drive the cover letter. */}
          <div className="flex flex-col gap-1">
            <span className="text-xs font-semibold">
              Why them (cover-letter angle)
            </span>
            <Textarea
              value={whyDraft}
              onChange={(e) => setWhyDraft(e.target.value)}
              onBlur={commitWhy}
              placeholder="Your genuine, specific angle for wanting this company…"
              className="min-h-0 resize-none text-xs py-1.5"
              rows={2}
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-semibold">
              Talking points (one per line)
            </span>
            <Textarea
              value={pointsDraft}
              onChange={(e) => setPointsDraft(e.target.value)}
              onBlur={commitPoints}
              placeholder="Specific hooks to use in the cover letter / interview…"
              className="min-h-0 resize-none text-xs py-1.5"
              rows={4}
            />
          </div>

          {/* Sources */}
          {research && research.sources.length > 0 && (
            <div className="flex flex-col gap-1 pt-1 border-t border-input/40">
              <span className="text-xs font-semibold text-muted-foreground">
                Sources
              </span>
              <ul className="flex flex-col gap-0.5">
                {research.sources.map((s, i) => (
                  <li key={i} className="text-[11px] truncate">
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary/80 hover:underline inline-flex items-center gap-1"
                      title={s.url}
                    >
                      <ExternalLink className="h-2.5 w-2.5 shrink-0" />
                      {s.title || s.url}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
