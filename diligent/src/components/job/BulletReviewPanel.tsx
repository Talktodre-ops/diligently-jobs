import { Check, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui";
import { CvExportPanel } from "./CvExportPanel";
import { TailoredSkillsPanel } from "./TailoredSkillsPanel";
import { SummaryEditPanel } from "./SummaryEditPanel";
import { TitleEditPanel } from "./TitleEditPanel";
import { resumeDocToFlatSections } from "@/lib/functions";
import type { CVSection, ResumeDoc, SkillGroup, TailoredBullet } from "@/types";

interface BulletReviewPanelProps {
  bullets: TailoredBullet[];
  cvVariant: CVSection[];
  /** Structured tailored CV — when present, export routes through the
   *  templated LaTeX path so the PDF matches the user's layout. */
  cvVariantDoc?: ResumeDoc | null;
  /** Reframed, editable headline shown under the candidate's name. */
  tailoredTitle?: string | null;
  onTitleChange?: (title: string) => void;
  /** Regenerated, editable skill groups for the target role. */
  tailoredSkills?: SkillGroup[] | null;
  onSkillsChange?: (skills: SkillGroup[]) => void;
  /** Regenerated, editable professional summary for the target role. */
  tailoredSummary?: string | null;
  onSummaryChange?: (summary: string) => void;
  isTailoring: boolean;
  hasRequirements: boolean;
  hasCv: boolean;
  onGenerate: () => void;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onAcceptAll: () => void;
  applicationId?: string;
}

const STATUS_CLASSES: Record<TailoredBullet["status"], string> = {
  pending: "",
  accepted: "bg-green-500/5 border-green-500/30",
  rejected: "bg-red-500/5 border-red-500/30 opacity-60",
};

const BulletRow = ({
  bullet,
  onAccept,
  onReject,
}: {
  bullet: TailoredBullet;
  onAccept: () => void;
  onReject: () => void;
}) => (
  <div
    className={`rounded-xl border border-input/50 p-3 flex flex-col gap-2 transition-colors ${STATUS_CLASSES[bullet.status]}`}
  >
    <div className="flex items-start justify-between gap-2">
      <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
        {bullet.section}
      </span>
      <div className="flex items-center gap-1 shrink-0">
        <Button
          size="icon"
          variant={bullet.status === "accepted" ? "default" : "outline"}
          className="h-6 w-6"
          onClick={onAccept}
          title={bullet.drop ? "Cut this bullet from the CV" : "Accept rewrite"}
        >
          <Check className="h-3 w-3" />
        </Button>
        <Button
          size="icon"
          variant={bullet.status === "rejected" ? "destructive" : "outline"}
          className="h-6 w-6"
          onClick={onReject}
          title={bullet.drop ? "Keep this bullet" : "Reject rewrite"}
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
    </div>

    <div className="grid grid-cols-2 gap-3">
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground font-medium">Original</span>
        <p className="text-xs leading-relaxed text-foreground/70">{bullet.original}</p>
      </div>
      {bullet.drop ? (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-amber-600 font-medium">Cut — off-domain</span>
          <p className="text-xs leading-relaxed text-muted-foreground italic">
            Not relevant to this role. Accept to drop it from the tailored CV, or
            reject to keep it.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground font-medium">Rewrite</span>
          <p className="text-xs leading-relaxed text-foreground">{bullet.rewrite}</p>
        </div>
      )}
    </div>
  </div>
);

export const BulletReviewPanel = ({
  bullets,
  cvVariant,
  cvVariantDoc,
  tailoredTitle,
  onTitleChange,
  tailoredSkills,
  onSkillsChange,
  tailoredSummary,
  onSummaryChange,
  isTailoring,
  hasRequirements,
  hasCv,
  onGenerate,
  onAccept,
  onReject,
  onAcceptAll,
  applicationId,
}: BulletReviewPanelProps) => {
  const acceptedCount = bullets.filter((b) => b.status === "accepted").length;
  const pendingCount = bullets.filter((b) => b.status === "pending").length;

  return (
    <div className="flex flex-col gap-3">
      {/* Summary / actions bar */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-3">
          {bullets.length > 0 && (
            <>
              <span className="text-xs text-muted-foreground">
                {acceptedCount} of {bullets.length} accepted
              </span>
              {pendingCount > 0 && (
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onAcceptAll}>
                  Accept all
                </Button>
              )}
            </>
          )}
        </div>
        <Button
          size="sm"
          onClick={onGenerate}
          disabled={isTailoring || !hasRequirements || !hasCv}
        >
          {isTailoring ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              Rewriting…
            </>
          ) : bullets.length > 0 ? (
            "Regenerate"
          ) : (
            "Generate rewrites"
          )}
        </Button>
      </div>

      {bullets.length === 0 && (
        <p className="text-xs text-muted-foreground italic">
          {!hasRequirements
            ? "Parse a JD first, then come back here."
            : !hasCv
            ? "Add CV bullets first."
            : 'Click "Generate rewrites" to see tailored versions of your bullets.'}
        </p>
      )}

      {/* Bullet rows */}
      {bullets.map((bullet) => (
        <BulletRow
          key={bullet.id}
          bullet={bullet}
          onAccept={() => onAccept(bullet.id)}
          onReject={() => onReject(bullet.id)}
        />
      ))}

      {/* CV variant preview */}
      {cvVariant.length > 0 && acceptedCount > 0 && (
        <div className="flex flex-col gap-2 mt-2 pt-3 border-t border-input/40">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Tailored CV preview
          </span>
          {/* Prefer the structured variant doc when present — it carries the
              reframed headline/roles, tailored summary, and regenerated skills,
              so the preview matches the exported PDF. The flat `cvVariant` only
              has bullet rewrites, so it would show stale titles/summary. */}
          {(cvVariantDoc ? resumeDocToFlatSections(cvVariantDoc) : cvVariant).map(
            (section) => (
              <div key={section.id} className="flex flex-col gap-1">
                <span className="text-xs font-semibold">{section.section}</span>
                <ul className="flex flex-col gap-0.5 pl-3">
                  {section.bullets.map((bullet, i) => (
                    <li key={i} className="text-xs text-foreground/80 list-disc">
                      {bullet}
                    </li>
                  ))}
                </ul>
              </div>
            )
          )}

          {/* Editable headline/job title — sits at the top of the exported CV.
              Edits are kept verbatim and rebuild the variant doc. */}
          {onTitleChange && (cvVariantDoc?.header.title || tailoredTitle) && (
            <TitleEditPanel
              title={cvVariantDoc?.header.title ?? tailoredTitle ?? ""}
              onChange={onTitleChange}
            />
          )}

          {/* Editable regenerated summary — senior-positioned, role-tuned.
              Always shown when editing is wired and a variant exists: use the
              AI-rewritten summary when present, else fall back to the variant
              doc's current summary so the user can always hand-edit it (even if
              the auto-rewrite failed). Edits rebuild the variant doc. */}
          {onSummaryChange && (cvVariantDoc?.summary || tailoredSummary) && (
            <SummaryEditPanel
              summary={cvVariantDoc?.summary ?? tailoredSummary ?? ""}
              onChange={onSummaryChange}
            />
          )}

          {/* Editable regenerated skills — coherent role-tuned groups.
              Edits rebuild the variant doc so the export reflects them. */}
          {tailoredSkills && tailoredSkills.length > 0 && onSkillsChange && (
            <TailoredSkillsPanel skills={tailoredSkills} onChange={onSkillsChange} />
          )}

          {/* Async render → R2 → presigned download. Snapshots a new
              cv_versions row each click; the backend dedupes in-flight
              renders for the same id. */}
          <CvExportPanel
            sections={cvVariant}
            resumeDoc={cvVariantDoc ?? undefined}
            applicationId={applicationId}
            label="tailored-export"
          />
        </div>
      )}
    </div>
  );
};
