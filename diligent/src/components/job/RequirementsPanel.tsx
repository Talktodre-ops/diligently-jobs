import type { JobRequirements } from "@/types";

interface RequirementsPanelProps {
  requirements: JobRequirements;
}

const Pill = ({ label }: { label: string }) => (
  <span className="inline-flex items-center rounded-full border border-input/60 bg-muted/50 px-2 py-0.5 text-xs text-foreground/80">
    {label}
  </span>
);

const Section = ({ title, items, emptyText }: { title: string; items: string[]; emptyText: string }) => (
  <div className="flex flex-col gap-1.5">
    <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{title}</span>
    {items.length === 0 ? (
      <span className="text-xs text-muted-foreground italic">{emptyText}</span>
    ) : (
      <div className="flex flex-wrap gap-1.5">
        {items.map((item, i) => (
          <Pill key={i} label={item} />
        ))}
      </div>
    )}
  </div>
);

export const RequirementsPanel = ({ requirements }: RequirementsPanelProps) => (
  <div className="flex flex-col gap-4">
    <Section title="Required" items={requirements.required} emptyText="None extracted" />
    <Section title="Nice to have" items={requirements.nice_to_have} emptyText="None extracted" />
    <Section title="ATS keywords" items={requirements.keywords} emptyText="None extracted" />
  </div>
);
