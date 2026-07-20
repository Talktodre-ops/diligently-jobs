import { useEffect, useState } from "react";
import { Check, Copy, Loader2, Send } from "lucide-react";
import { Button, Textarea } from "@/components/ui";
import type { FollowUp, FollowUpPlan } from "@/types";

interface FollowUpPanelProps {
  plan: FollowUpPlan | null;
  isPlanning: boolean;
  hasRequirements: boolean;
  streamStatus: string;
  onGenerate: () => void;
  onToggle: (id: string) => void;
  onDraftChange: (id: string, draft: string) => void;
}

const FollowUpCard = ({
  item,
  onToggle,
  onDraftChange,
}: {
  item: FollowUp;
  onToggle: () => void;
  onDraftChange: (draft: string) => void;
}) => {
  const [draft, setDraft] = useState(item.draft);
  const [copied, setCopied] = useState(false);
  useEffect(() => setDraft(item.draft), [item.draft]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(draft);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — ignore */
    }
  };

  return (
    <div
      className={`rounded-xl border border-input/50 p-3 flex flex-col gap-2 ${
        item.status === "done" ? "opacity-60 bg-emerald-500/5 border-emerald-500/30" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="text-xs font-semibold">{item.label}</span>
          <span className="text-[11px] text-muted-foreground">
            {[item.timing, item.channel, item.target].filter(Boolean).join(" · ")}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            onClick={copy}
            title="Copy message"
          >
            <Copy className="h-3 w-3" />
          </Button>
          <Button
            size="icon"
            variant={item.status === "done" ? "default" : "outline"}
            className="h-6 w-6"
            onClick={onToggle}
            title={item.status === "done" ? "Mark not done" : "Mark done"}
          >
            <Check className="h-3 w-3" />
          </Button>
        </div>
      </div>
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => onDraftChange(draft)}
        className="min-h-0 resize-none text-xs py-1.5 leading-relaxed"
        rows={4}
      />
      {copied && <span className="text-[11px] text-emerald-600">Copied ✓</span>}
    </div>
  );
};

export const FollowUpPanel = ({
  plan,
  isPlanning,
  hasRequirements,
  streamStatus,
  onGenerate,
  onToggle,
  onDraftChange,
}: FollowUpPanelProps) => {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        A realistic follow-up cadence with ready-to-send drafts — who to reach,
        on which channel, and when. Edit any draft, copy it, and tick it off
        once sent.
      </p>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={onGenerate}
          disabled={isPlanning || !hasRequirements}
          className="text-xs"
        >
          {isPlanning ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              Planning…
            </>
          ) : (
            <>
              <Send className="h-3 w-3" />
              {plan ? "Re-plan follow-ups" : "Plan follow-ups"}
            </>
          )}
        </Button>
        {!hasRequirements && (
          <span className="text-xs text-amber-600">Parse the JD first (tab 1).</span>
        )}
      </div>

      {isPlanning && streamStatus && (
        <p className="text-xs text-muted-foreground line-clamp-2">{streamStatus}</p>
      )}

      {plan && plan.followups.length > 0 && (
        <div className="flex flex-col gap-2">
          {plan.followups.map((f) => (
            <FollowUpCard
              key={f.id}
              item={f}
              onToggle={() => onToggle(f.id)}
              onDraftChange={(d) => onDraftChange(f.id, d)}
            />
          ))}
        </div>
      )}
    </div>
  );
};
