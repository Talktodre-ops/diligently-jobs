import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button, Input, Textarea } from "@/components/ui";
import type { SkillGroup } from "@/types";

interface TailoredSkillsPanelProps {
  skills: SkillGroup[];
  onChange: (skills: SkillGroup[]) => void;
}

const parseItems = (raw: string): string[] =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Inline editor for the regenerated Skills section. Each group is a label +
 * a comma-separated item list.
 *
 * Item lists are edited as raw strings (local draft) so commas/spaces type
 * naturally; they're parsed back into the array on blur. Labels commit on
 * change (no parsing needed). Edits propagate via onChange → the export
 * reflects them.
 */
export const TailoredSkillsPanel = ({ skills, onChange }: TailoredSkillsPanelProps) => {
  // Raw per-group item strings. Synced from props when the skills change
  // (e.g. after regeneration), edited freely, committed on blur.
  const [drafts, setDrafts] = useState<string[]>(() =>
    skills.map((g) => g.items.join(", "))
  );

  useEffect(() => {
    setDrafts(skills.map((g) => g.items.join(", ")));
  }, [skills]);

  const updateLabel = (idx: number, label: string) => {
    onChange(skills.map((g, i) => (i === idx ? { ...g, label } : g)));
  };

  const commitItems = (idx: number) => {
    const items = parseItems(drafts[idx] ?? "");
    onChange(skills.map((g, i) => (i === idx ? { ...g, items } : g)));
  };

  const removeGroup = (idx: number) => {
    onChange(skills.filter((_, i) => i !== idx));
  };

  const addGroup = () => {
    onChange([...skills, { label: "New group", items: [] }]);
  };

  return (
    <div className="flex flex-col gap-2 mt-2 pt-3 border-t border-input/40">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Tailored skills (editable)
        </span>
        <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={addGroup}>
          <Plus className="h-3 w-3" />
          Add group
        </Button>
      </div>

      {skills.map((group, idx) => (
        <div
          key={idx}
          className="flex flex-col gap-1.5 rounded-xl border border-input/50 p-2.5"
        >
          <div className="flex items-center gap-2">
            <Input
              value={group.label}
              onChange={(e) => updateLabel(idx, e.target.value)}
              className="h-7 text-xs font-semibold"
              placeholder="Group label (e.g. Cloud & DevOps)"
            />
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 shrink-0"
              onClick={() => removeGroup(idx)}
              title="Remove group"
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
          <Textarea
            value={drafts[idx] ?? ""}
            onChange={(e) =>
              setDrafts((prev) => prev.map((d, i) => (i === idx ? e.target.value : d)))
            }
            onBlur={() => commitItems(idx)}
            placeholder="Comma-separated skills…"
            className="min-h-0 resize-none text-xs py-1.5"
            rows={2}
          />
        </div>
      ))}
    </div>
  );
};
