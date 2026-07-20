import {
  Loader2,
  Wrench,
  Workflow,
  ExternalLink,
  Copy,
  Check,
  X,
} from "lucide-react";
import { Button } from "@/components/ui";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { ArchitectureDiagram } from "./ArchitectureDiagram";
import type {
  ArchitectureDoc,
  ProjectResearch,
  RelatedProject,
  SolutionBrief,
} from "@/types";

interface ApproachPanelProps {
  brief: SolutionBrief | null;
  research: ProjectResearch | null;
  architecture: ArchitectureDoc | null;
  isBuilding: boolean;
  isDiagramming: boolean;
  hasRequirements: boolean;
  streamStatus: string;
  onRun: () => void;
  onGenerateDiagram: () => void;
  onRemoveProject: (index: number) => void;
}

/** Small copy button bound to a fixed piece of text. */
const CopyBtn = ({ text, title }: { text: string; title: string }) => {
  const { isCopied, handleCopy } = useCopyToClipboard({ text });
  return (
    <Button
      size="icon"
      variant="ghost"
      className="h-5 w-5 shrink-0"
      onClick={handleCopy}
      disabled={!text}
      title={title}
    >
      {isCopied ? (
        <Check className="h-3 w-3 text-emerald-500" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
    </Button>
  );
};

const ProjectCard = ({
  project,
  onRemove,
}: {
  project: RelatedProject;
  onRemove: () => void;
}) => (
  <div className="flex flex-col gap-1.5 rounded-xl border border-input/50 p-3">
    <div className="flex items-start justify-between gap-2">
      <a
        href={project.url}
        target="_blank"
        rel="noreferrer"
        className="text-xs font-semibold text-primary/90 hover:underline inline-flex items-center gap-1 min-w-0"
        title={project.url}
      >
        <ExternalLink className="h-3 w-3 shrink-0" />
        <span className="truncate">{project.name}</span>
      </a>
      <div className="flex items-center gap-1 shrink-0">
        {project.language && (
          <span className="rounded-md border border-input/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {project.language}
          </span>
        )}
        <Button
          size="icon"
          variant="ghost"
          className="h-5 w-5"
          onClick={onRemove}
          title="Remove from list"
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
    </div>

    {project.description && (
      <p className="text-[11px] text-foreground/80">{project.description}</p>
    )}
    {project.why_relevant && (
      <p className="text-[11px] text-muted-foreground">
        <span className="font-semibold text-foreground/70">Why: </span>
        {project.why_relevant}
      </p>
    )}

    {project.clone && (
      <div className="flex items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1">
        <code className="flex-1 min-w-0 truncate text-[10px] font-mono text-foreground/80">
          {project.clone}
        </code>
        <CopyBtn text={project.clone} title="Copy clone command" />
      </div>
    )}
  </div>
);

const ListBlock = ({ label, items }: { label: string; items: string[] }) =>
  items.length > 0 ? (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-semibold">{label}</span>
      <ul className="flex flex-col gap-0.5 pl-3">
        {items.map((it, i) => (
          <li key={i} className="text-[11px] text-foreground/80 list-disc">
            {it}
          </li>
        ))}
      </ul>
    </div>
  ) : null;

export const ApproachPanel = ({
  brief,
  research,
  architecture,
  isBuilding,
  isDiagramming,
  hasRequirements,
  streamStatus,
  onRun,
  onGenerateDiagram,
  onRemoveProject,
}: ApproachPanelProps) => {
  const projects = research?.projects ?? [];

  return (
    <div className="flex flex-col gap-4 min-w-0">
      <p className="text-xs text-muted-foreground">
        This is the spine of a winning proposal: derive the{" "}
        <strong>specific technical challenges</strong> of this job, a{" "}
        <strong>high-level approach</strong>, and a <strong>proof plan</strong> —
        plus clonable open-source projects so you can build a quick{" "}
        <strong>proof-of-concept demo</strong>. The proposal is generated from
        this, so it speaks the client's problem, not generic claims.
      </p>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={onRun}
          disabled={isBuilding || !hasRequirements}
          className="text-xs"
        >
          {isBuilding ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              Building…
            </>
          ) : (
            <>
              <Wrench className="h-3 w-3" />
              {brief || research ? "Re-build approach" : "Build approach & find projects"}
            </>
          )}
        </Button>
        {!hasRequirements && (
          <span className="text-xs text-amber-600">
            Parse the job post first (tab 1).
          </span>
        )}
      </div>

      {isBuilding && streamStatus && (
        <p className="text-xs text-muted-foreground line-clamp-2">
          {streamStatus}
        </p>
      )}

      {/* Solution brief */}
      {brief && (
        <div className="flex flex-col gap-3 rounded-xl border border-input/50 p-3">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            How I'd solve this
          </span>

          {brief.challenges.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold">Key challenges → solution</span>
              {brief.challenges.map((c, i) => (
                <div key={i} className="text-[11px] leading-relaxed">
                  <span className="font-semibold text-foreground/90">
                    {c.challenge}
                  </span>
                  {c.solution && (
                    <span className="text-muted-foreground"> → {c.solution}</span>
                  )}
                </div>
              ))}
            </div>
          )}

          {brief.approach.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-semibold">High-level approach</span>
              <ol className="flex flex-col gap-0.5 pl-4">
                {brief.approach.map((s, i) => (
                  <li key={i} className="text-[11px] text-foreground/80 list-decimal">
                    {s}
                  </li>
                ))}
              </ol>
            </div>
          )}

          <ListBlock label="Proof / PoC strategy" items={brief.proof_strategy} />

          {brief.json_sample && (
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold">Sample structured output</span>
                <CopyBtn text={brief.json_sample} title="Copy JSON sample" />
              </div>
              <pre className="max-w-full min-w-0 overflow-x-auto rounded-md bg-muted/50 p-2 text-[10px] font-mono text-foreground/80 [scrollbar-width:thin]">
                {brief.json_sample}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* Architecture diagram — downloadable, to attach to the proposal */}
      <div className="flex flex-col gap-2 rounded-xl border border-input/50 p-3 min-w-0">
        {/* Button kept on the LEFT (not pushed right by justify-between) so it's
            always visible without horizontal scrolling. */}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={architecture ? "outline" : "default"}
            onClick={onGenerateDiagram}
            disabled={isDiagramming || !hasRequirements}
            className="text-xs h-7"
          >
            {isDiagramming ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                Drawing…
              </>
            ) : (
              <>
                <Workflow className="h-3 w-3" />
                {architecture ? "Re-generate" : "Generate diagram"}
              </>
            )}
          </Button>
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Architecture diagram
          </span>
        </div>
        <p className="text-[11px] text-muted-foreground">
          A diagram shows initiative and that you understand the problem in
          blocks — clients often decide on it. Generate it (it uses the approach
          above), then download a PNG and attach it to your proposal.
        </p>
        {isDiagramming && streamStatus && (
          <p className="text-xs text-muted-foreground line-clamp-2">
            {streamStatus}
          </p>
        )}
        {architecture && <ArchitectureDiagram code={architecture.mermaid} />}
      </div>

      {/* Clonable projects — the PoC starting point */}
      {projects.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Clone to build your PoC
          </span>
          {projects.map((p, i) => (
            <ProjectCard
              key={p.url + i}
              project={p}
              onRemove={() => onRemoveProject(i)}
            />
          ))}
        </div>
      )}

      {research && research.sources.length > 0 && (
        <div className="flex flex-col gap-1 pt-1 border-t border-input/40">
          <span className="text-xs font-semibold text-muted-foreground">
            Searched sources
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
  );
};
