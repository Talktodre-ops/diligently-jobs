import { useEffect, useState } from "react";
import { Loader2, MessageSquare, Copy, Check } from "lucide-react";
import { Button, Textarea } from "@/components/ui";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import type { ScreeningAnswers, ScreeningQA } from "@/types";

interface ScreeningPanelProps {
  questionsRaw: string;
  onQuestionsChange: (text: string) => void;
  screening: ScreeningAnswers | null;
  isAnswering: boolean;
  hasRequirements: boolean;
  streamStatus: string;
  onGenerate: () => void;
  onUpdateAnswer: (index: number, text: string) => void;
}

const AnswerCard = ({
  qa,
  index,
  onUpdateAnswer,
}: {
  qa: ScreeningQA;
  index: number;
  onUpdateAnswer: (index: number, text: string) => void;
}) => {
  const [draft, setDraft] = useState(qa.answer);
  useEffect(() => setDraft(qa.answer), [qa.answer]);

  const { isCopied, handleCopy } = useCopyToClipboard({ text: draft });

  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-input/50 p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-semibold text-foreground/90">
          {index + 1}. {qa.question}
        </p>
        <Button
          size="icon"
          variant="ghost"
          className="h-5 w-5 shrink-0"
          onClick={handleCopy}
          disabled={!draft.trim()}
          title="Copy answer"
        >
          {isCopied ? (
            <Check className="h-3 w-3 text-emerald-500" />
          ) : (
            <Copy className="h-3 w-3" />
          )}
        </Button>
      </div>
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => onUpdateAnswer(index, draft)}
        className="min-h-0 resize-none text-xs py-1.5 leading-relaxed"
        rows={3}
        placeholder="Answer…"
      />
    </div>
  );
};

export const ScreeningPanel = ({
  questionsRaw,
  onQuestionsChange,
  screening,
  isAnswering,
  hasRequirements,
  streamStatus,
  onGenerate,
  onUpdateAnswer,
}: ScreeningPanelProps) => {
  const [draft, setDraft] = useState(questionsRaw);
  useEffect(() => setDraft(questionsRaw), [questionsRaw]);

  const items = screening?.items ?? [];

  // "Copy all" joins each Q&A — handy when pasting into a single notes box.
  const allText = items
    .map((qa, i) => `${i + 1}. ${qa.question}\n${qa.answer}`)
    .join("\n\n");
  const { isCopied: allCopied, handleCopy: copyAll } = useCopyToClipboard({
    text: allText,
  });

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        Upwork often asks extra <strong>screening questions</strong> when you
        submit. Paste them here (one per line) and get specific, honest answers
        grounded in your CV{items.length ? "" : " + the projects you found"} and
        consistent with your proposal — each editable and copy-ready.
      </p>

      {/* Questions input */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Screening questions (one per line)
        </span>
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => onQuestionsChange(draft)}
          placeholder={
            "e.g.\nHave you built systems that measure PDF construction plans?\nDid your prior work return coordinates or polygons?\nAre you applying as an individual or a team?"
          }
          className="min-h-0 resize-none text-xs py-1.5 leading-relaxed"
          rows={5}
          disabled={isAnswering}
        />
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={onGenerate}
          disabled={isAnswering || !hasRequirements || !draft.trim()}
          className="text-xs"
        >
          {isAnswering ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              Answering…
            </>
          ) : (
            <>
              <MessageSquare className="h-3 w-3" />
              {screening ? "Re-answer" : "Answer questions"}
            </>
          )}
        </Button>
        {!hasRequirements && (
          <span className="text-xs text-amber-600">
            Parse the job post first (tab 1).
          </span>
        )}
      </div>

      {isAnswering && streamStatus && (
        <p className="text-xs text-muted-foreground line-clamp-2">
          {streamStatus}
        </p>
      )}

      {/* Answers */}
      {items.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Answers
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={copyAll}
              className="text-xs h-7"
            >
              {allCopied ? (
                <>
                  <Check className="h-3 w-3 text-emerald-500" />
                  Copied all
                </>
              ) : (
                <>
                  <Copy className="h-3 w-3" />
                  Copy all
                </>
              )}
            </Button>
          </div>
          {items.map((qa, i) => (
            <AnswerCard
              key={i}
              qa={qa}
              index={i}
              onUpdateAnswer={onUpdateAnswer}
            />
          ))}
        </div>
      )}
    </div>
  );
};
