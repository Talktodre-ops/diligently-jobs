import { useEffect, useState } from "react";
import { MessageSquareIcon } from "lucide-react";
import { Textarea } from "@/components/ui";

interface Props {
  value: string | undefined;
  onSave: (text: string) => void;
}

const PLACEHOLDER = `Optional. Extra context Claude should know during interview mode for THIS role.

Examples:
- "Staff Engineer role at a fintech. Expect deep system-design on payment rails + consistency."
- "Emphasize my open-source contributions when relevant."
- "Hiring panel is 4 people — keep answers tight."`;

/**
 * Workspace-scoped interview notes. Appended to the composed interview
 * system prompt as ROLE-SPECIFIC NOTES so Claude has per-role steering
 * beyond what the parsed JD captures.
 *
 * Debounced save: 500ms after the user stops typing. Avoids hammering
 * localStorage on every keystroke.
 */
export const InterviewNotesPanel = ({ value, onSave }: Props) => {
  const [text, setText] = useState(value ?? "");

  // Keep local state in sync when the workspace switches.
  useEffect(() => {
    setText(value ?? "");
  }, [value]);

  useEffect(() => {
    const id = window.setTimeout(() => {
      if ((value ?? "") !== text) {
        onSave(text);
      }
    }, 500);
    return () => window.clearTimeout(id);
  }, [text, value, onSave]);

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-input/50 p-3">
      <div className="flex items-center gap-2">
        <MessageSquareIcon className="h-3 w-3 text-muted-foreground" />
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Interview notes for this role
        </span>
      </div>
      <p className="text-xs text-muted-foreground italic">
        Steers Claude's answers during interview mode for this workspace only.
        Auto-saves.
      </p>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={PLACEHOLDER}
        className="min-h-[100px] text-xs"
      />
    </div>
  );
};
