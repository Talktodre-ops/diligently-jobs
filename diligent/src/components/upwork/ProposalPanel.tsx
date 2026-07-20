import { useEffect, useState } from "react";
import { Loader2, PenLine, Copy, Check, CircleDot, Circle } from "lucide-react";
import { Button, Textarea } from "@/components/ui";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import type { Proposal, ProposalLength } from "@/types";

interface ProposalPanelProps {
  proposal: Proposal | null;
  isGenerating: boolean;
  hasRequirements: boolean;
  hasProjects: boolean;
  streamStatus: string;
  onGenerate: (length: ProposalLength) => void;
  onSelectOpener: (index: number) => void;
  onUpdateOpener: (index: number, text: string) => void;
  onUpdateBody: (text: string) => void;
}

export const ProposalPanel = ({
  proposal,
  isGenerating,
  hasRequirements,
  hasProjects,
  streamStatus,
  onGenerate,
  onSelectOpener,
  onUpdateOpener,
  onUpdateBody,
}: ProposalPanelProps) => {
  const [length, setLength] = useState<ProposalLength>(
    proposal?.length ?? "short"
  );
  const [openerDrafts, setOpenerDrafts] = useState<string[]>(
    proposal?.openers ?? []
  );
  const [bodyDraft, setBodyDraft] = useState(proposal?.body ?? "");

  useEffect(() => {
    setOpenerDrafts(proposal?.openers ?? []);
    setBodyDraft(proposal?.body ?? "");
    if (proposal?.length) setLength(proposal.length);
  }, [proposal]);

  const selected = proposal?.selected_opener ?? 0;
  const selectedOpenerText = (openerDrafts[selected] ?? "").trim();
  const composed = [selectedOpenerText, bodyDraft.trim()]
    .filter(Boolean)
    .join("\n\n");
  const { isCopied, handleCopy } = useCopyToClipboard({ text: composed });

  const bodyWords = bodyDraft.trim() ? bodyDraft.trim().split(/\s+/).length : 0;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        An AIDA proposal with a <strong>hyper-specific opening line</strong> (the
        part clients actually read). Pick the best opener, edit freely, then
        copy-paste into Upwork. Grounded in your CV
        {hasProjects ? " + the projects you found" : ""} — never fabricated.
      </p>

      {/* Length toggle + generate */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center rounded-lg border border-input/60 p-0.5">
          {(["short", "detailed"] as ProposalLength[]).map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setLength(l)}
              className={`rounded-md px-2 py-1 text-[11px] capitalize transition-colors ${
                length === l
                  ? "bg-accent font-semibold"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {l}
            </button>
          ))}
        </div>

        <Button
          size="sm"
          onClick={() => onGenerate(length)}
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
              {proposal ? "Re-generate" : "Generate proposal"}
            </>
          )}
        </Button>

        {!hasRequirements ? (
          <span className="text-xs text-amber-600">
            Parse the job post first (tab 1).
          </span>
        ) : !hasProjects ? (
          <span className="text-xs text-muted-foreground">
            Tip: find projects (tab 2) first for stronger proof.
          </span>
        ) : null}
      </div>

      {isGenerating && streamStatus && (
        <p className="text-xs text-muted-foreground line-clamp-3">
          {streamStatus}
        </p>
      )}

      {proposal && (
        <>
          {/* Opener picker */}
          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Opening line — pick the strongest
            </span>
            {openerDrafts.length === 0 && (
              <p className="text-[11px] text-muted-foreground italic">
                No opener variants returned — write your own opener into the body
                below, or re-generate.
              </p>
            )}
            {openerDrafts.map((opener, i) => {
              const isSel = i === selected;
              return (
                <div
                  key={i}
                  onClick={() => onSelectOpener(i)}
                  className={`flex flex-col gap-1 rounded-xl border p-2 cursor-pointer transition-colors ${
                    isSel
                      ? "border-primary/60 bg-primary/5"
                      : "border-input/50 hover:border-input"
                  }`}
                >
                  <div className="flex items-center gap-1.5 text-[11px] font-semibold">
                    {isSel ? (
                      <CircleDot className="h-3 w-3 text-primary" />
                    ) : (
                      <Circle className="h-3 w-3 text-muted-foreground" />
                    )}
                    <span className={isSel ? "text-primary" : "text-muted-foreground"}>
                      Opener {i + 1}
                      {isSel ? " · selected" : ""}
                    </span>
                  </div>
                  <Textarea
                    value={opener}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      const next = openerDrafts.slice();
                      next[i] = e.target.value;
                      setOpenerDrafts(next);
                    }}
                    onBlur={() => onUpdateOpener(i, openerDrafts[i] ?? "")}
                    className="min-h-0 resize-none text-xs py-1.5 leading-relaxed bg-transparent"
                    rows={2}
                  />
                </div>
              );
            })}
          </div>

          {/* Body */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Proposal body
              </span>
              <span className="text-[11px] text-muted-foreground">
                {bodyWords} words
              </span>
            </div>
            <Textarea
              value={bodyDraft}
              onChange={(e) => setBodyDraft(e.target.value)}
              onBlur={() => onUpdateBody(bodyDraft)}
              className="min-h-0 resize-none text-xs py-1.5 leading-relaxed"
              rows={14}
              placeholder="Proposal body…"
            />
          </div>

          {/* Copy the composed, paste-ready proposal */}
          <div className="flex items-center justify-between gap-2 rounded-xl border border-input/50 bg-muted/20 px-3 py-2">
            <span className="text-[11px] text-muted-foreground">
              Copies the selected opener + body, ready to paste into Upwork.
            </span>
            <Button
              size="sm"
              onClick={handleCopy}
              disabled={!composed}
              className="text-xs shrink-0"
            >
              {isCopied ? (
                <>
                  <Check className="h-3 w-3 text-emerald-400" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="h-3 w-3" />
                  Copy proposal
                </>
              )}
            </Button>
          </div>
        </>
      )}
    </div>
  );
};
