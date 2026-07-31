import { useEffect, useRef, useState } from "react";
import { Plus, Trash2, Sparkles } from "lucide-react";
import {
  Button,
  ScrollArea,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui";
import { useJobWorkspace } from "@/hooks";
import type { CvSavePayload } from "@/hooks/useJobWorkspace";
import type { ApplicationStage, JobWorkspace } from "@/types";
import { JDInputPanel } from "./JDInputPanel";
import { RequirementsPanel } from "./RequirementsPanel";
import { CVEditor } from "./CVEditor";
import { ResearchPanel } from "./ResearchPanel";
import { GapAnalysis } from "./GapAnalysis";
import { BulletReviewPanel } from "./BulletReviewPanel";
import { CoverLetterPanel } from "./CoverLetterPanel";
import { FollowUpPanel } from "./FollowUpPanel";
import { PipelineBar } from "./PipelineBar";
import { InterviewNotesPanel } from "./InterviewNotesPanel";

type ActiveTab =
  | "jd"
  | "research"
  | "cv"
  | "gaps"
  | "tailor"
  | "cover"
  | "followup";

/** Derive a sensible pipeline stage from what's been produced, unless the user
 *  set one explicitly. Manual stages (submitted+) always win once chosen. */
function deriveStage(ws: JobWorkspace): ApplicationStage {
  if (ws.pipeline_status) return ws.pipeline_status;
  if (ws.cover_letter) return "letter_ready";
  if (ws.tailored_bullets.length > 0) return "tailored";
  if (ws.company_research) return "researched";
  return "draft";
}

/**
 * Pipeline auto-progression rules (target UX):
 *   Parse JD success      → if CV present, auto-run analyze + tailor;
 *                            if not, switch to CV tab and wait
 *   Save CV success       → if requirements present, auto-run analyze + tailor;
 *                            if not, switch to JD tab and wait
 *   Pipeline runs once    → cleared when bullets land OR user explicitly switches tabs
 *
 * Loading an existing workspace does NOT trigger the pipeline — only explicit
 * Parse JD / Save CV actions arm it.
 */
export const JobModePanel = () => {
  const {
    jdText,
    setJDText,
    workspace,
    baseCV,
    baseCVDoc,
    baseCVLoading,
    baseCVError,
    reloadBaseCV,
    allWorkspaces,
    isParsingJD,
    isAnalyzingGaps,
    isTailoring,
    streamStatus,
    error,
    parseJD,
    analyzeGaps,
    generateTailoredBullets,
    acceptBullet,
    rejectBullet,
    acceptAllBullets,
    updateTailoredSkills,
    updateTailoredSummary,
    updateTailoredTitle,
    isResearching,
    runResearch,
    updateCompanyBrief,
    setResearchPaste,
    isGeneratingCoverLetter,
    generateCoverLetter,
    updateCoverLetterDoc,
    isPlanningFollowups,
    isBuildingKit,
    generateFollowUps,
    toggleFollowUp,
    updateFollowUpDraft,
    setPipelineStatus,
    generateApplicationKit,
    updateBaseCV,
    persistBaseCVDoc,
    updateInterviewPrompt,
    newWorkspace,
    loadWorkspace,
    deleteWorkspace,
  } = useJobWorkspace();

  const isStreaming =
    isParsingJD ||
    isAnalyzingGaps ||
    isTailoring ||
    isResearching ||
    isGeneratingCoverLetter ||
    isPlanningFollowups ||
    isBuildingKit;
  const hasResearch = !!workspace.company_research;
  const hasCoverLetter = !!workspace.cover_letter;
  const hasFollowups = !!workspace.followups;
  const stage = deriveStage(workspace);
  const hasCv = baseCV.length > 0 || workspace.cv_snapshot.length > 0;
  const hasReq = !!workspace.requirements;
  const hasGaps = workspace.gaps.length > 0;
  const hasBullets = workspace.tailored_bullets.length > 0;

  const [activeTab, setActiveTab] = useState<ActiveTab>("jd");
  const [pipelineArmed, setPipelineArmed] = useState(false);
  /** Tracks which auto-step we last fired so the effect doesn't re-trigger
   *  while the same async call is still in flight (state updates lag). */
  const lastFiredRef = useRef<"analyze" | "tailor" | null>(null);
  /** Research fires once per armed run, independent of the CV-gated steps. */
  const researchFiredRef = useRef(false);

  // === Wrapped action handlers — arm the pipeline whenever the user
  // explicitly triggers a step. ===

  const handleParseJD = async () => {
    setPipelineArmed(true);
    lastFiredRef.current = null;
    researchFiredRef.current = false;
    await parseJD();
  };

  const handleSaveCV = (payload: CvSavePayload) => {
    setPipelineArmed(true);
    lastFiredRef.current = null;
    // Return the promise so CVEditor can await the cloud write + surface errors.
    return updateBaseCV(payload);
  };

  // === Auto-progression effect — figures out the next step every time the
  // workspace state changes. ===

  useEffect(() => {
    if (!pipelineArmed) return;

    // Company research fires as soon as we have a company name — independent
    // of the CV / gaps / tailor steps, so it runs in the background and tab 2
    // fills in while the CV pipeline proceeds.
    if (
      hasReq &&
      !hasResearch &&
      !!workspace.requirements?.company?.trim() &&
      !researchFiredRef.current &&
      !isResearching
    ) {
      researchFiredRef.current = true;
      runResearch();
    }

    if (isParsingJD || isAnalyzingGaps || isTailoring) return; // wait for in-flight

    // Need both inputs before we can do anything past parseJD.
    if (!hasReq) return;
    if (!hasCv) {
      // Park on the CV tab — user needs to upload/paste their CV before
      // gaps + tailoring can run.
      setActiveTab("cv");
      return;
    }

    // Run gap analysis if we have inputs but no gaps yet.
    if (!hasGaps && lastFiredRef.current !== "analyze") {
      lastFiredRef.current = "analyze";
      setActiveTab("gaps");
      analyzeGaps();
      return;
    }

    // Run tailoring if we have gaps but no bullets yet.
    if (hasGaps && !hasBullets && lastFiredRef.current !== "tailor") {
      lastFiredRef.current = "tailor";
      setActiveTab("tailor");
      generateTailoredBullets();
      return;
    }

    // Pipeline reached the end — bullets are in.
    if (hasBullets) {
      setActiveTab("tailor");
      setPipelineArmed(false);
      lastFiredRef.current = null;
    }
  }, [
    pipelineArmed,
    hasReq,
    hasCv,
    hasGaps,
    hasBullets,
    hasResearch,
    isResearching,
    isParsingJD,
    isAnalyzingGaps,
    isTailoring,
    analyzeGaps,
    generateTailoredBullets,
    runResearch,
    workspace.requirements,
  ]);

  // Loading a different workspace should reset pipeline state — old workspace
  // might already have gaps/bullets and we don't want to re-fire.
  useEffect(() => {
    setPipelineArmed(false);
    lastFiredRef.current = null;
    researchFiredRef.current = false;
  }, [workspace.id]);

  // Pipeline status banner text
  const pipelineMsg = pipelineArmed
    ? isAnalyzingGaps
      ? "Analyzing gaps…"
      : isTailoring
        ? "Tailoring bullets…"
        : !hasCv
          ? "Upload your CV to continue the pipeline →"
          : !hasReq
            ? "Parse the JD to continue the pipeline →"
            : null
    : null;

  return (
    <div className="flex w-screen overflow-hidden" style={{ maxHeight: "70vh" }}>
      {/* Sidebar — previous workspaces.
          `min-h-0` here and on the ScrollArea below for the same reason as the
          main content: without it the column grows to fit every workspace, the
          70vh cap never bites, and newly added workspaces fall off the bottom
          with no way to scroll to them. */}
      <div className="w-44 shrink-0 border-r border-input/50 flex flex-col min-h-0">
        <div className="flex items-center justify-between px-3 py-2 border-b border-input/30">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Workspaces
          </span>
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            onClick={newWorkspace}
            title="New workspace"
          >
            <Plus className="h-3 w-3" />
          </Button>
        </div>

        <ScrollArea className="flex-1 min-h-0">
          <div className="flex flex-col gap-0.5 p-1.5">
            {allWorkspaces.length === 0 && (
              <p className="text-xs text-muted-foreground italic px-2 py-1">
                No saved workspaces
              </p>
            )}
            {allWorkspaces
              .slice()
              .sort((a, b) => b.updatedAt - a.updatedAt)
              .map((ws) => (
                <div
                  key={ws.id}
                  className={`group flex items-center gap-1 rounded-lg px-2 py-1.5 cursor-pointer hover:bg-accent transition-colors ${
                    ws.id === workspace.id ? "bg-accent" : ""
                  }`}
                  onClick={() => loadWorkspace(ws.id)}
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate">
                      {ws.requirements?.role || "Untitled"}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {ws.requirements?.company || "—"}
                    </p>
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-5 w-5 opacity-0 group-hover:opacity-100 shrink-0"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteWorkspace(ws.id);
                    }}
                    title="Delete workspace"
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))}
          </div>
        </ScrollArea>
      </div>

      {/* Main content
          `min-h-0` on every flex-1 in the chain is what actually lets the
          ScrollArea overflow: flex children default to `min-height: auto`
          which makes them grow to fit content, so the bounded height never
          kicks in and the inner content never overflows the viewport. */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as ActiveTab)}
          className="flex flex-col flex-1 min-h-0 overflow-hidden"
        >
          <div className="flex items-center justify-between gap-2 px-3 pt-2 pb-0 border-b border-input/30">
            {/* Horizontal scroll: with 6 tabs the strip exceeds the fixed
                window width, so let it scroll left/right instead of clipping.
                `min-w-0` lets the flex item shrink; `w-max` keeps the triggers
                their natural size (no squish); thin scrollbar stays out of the
                way. */}
            <div className="flex-1 min-w-0 overflow-x-auto overflow-y-hidden [scrollbar-width:thin]">
              <TabsList className="h-8 w-max">
              <TabsTrigger value="jd" className="text-xs px-2.5">
                1 · JD
                {hasReq && <span className="ml-1 text-emerald-500">✓</span>}
              </TabsTrigger>
              <TabsTrigger value="research" className="text-xs px-2.5">
                2 · Research
                {hasResearch && <span className="ml-1 text-emerald-500">✓</span>}
              </TabsTrigger>
              <TabsTrigger value="cv" className="text-xs px-2.5">
                3 · Your CV
                {hasCv && <span className="ml-1 text-emerald-500">✓</span>}
              </TabsTrigger>
              <TabsTrigger value="gaps" className="text-xs px-2.5">
                4 · Gaps
                {hasGaps && <span className="ml-1 text-emerald-500">✓</span>}
              </TabsTrigger>
              <TabsTrigger value="tailor" className="text-xs px-2.5">
                5 · Tailor
                {hasBullets && <span className="ml-1 text-emerald-500">✓</span>}
              </TabsTrigger>
              <TabsTrigger value="cover" className="text-xs px-2.5">
                6 · Cover Letter
                {hasCoverLetter && <span className="ml-1 text-emerald-500">✓</span>}
              </TabsTrigger>
              <TabsTrigger value="followup" className="text-xs px-2.5">
                7 · Follow-up
                {hasFollowups && <span className="ml-1 text-emerald-500">✓</span>}
              </TabsTrigger>
              </TabsList>
            </div>

            {workspace.requirements && (
              <span className="text-xs text-muted-foreground truncate max-w-36 shrink-0">
                {workspace.requirements.role}
                {workspace.requirements.company
                  ? ` @ ${workspace.requirements.company}`
                  : ""}
              </span>
            )}
          </div>

          <ScrollArea className="flex-1 min-h-0">
            <div className="p-3">
              {error && (
                <div className="mb-3 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {error}
                </div>
              )}

              {pipelineMsg && (
                <div className="mb-3 rounded-xl border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-primary flex items-center gap-2">
                  <Sparkles className="h-3 w-3" />
                  <span>{pipelineMsg}</span>
                </div>
              )}

              {isStreaming && streamStatus && (
                <div className="mb-3 rounded-xl border border-input/30 bg-muted/30 px-3 py-2 text-xs text-muted-foreground line-clamp-2">
                  {streamStatus}
                </div>
              )}

              {workspace.requirements && (
                <PipelineBar
                  stage={stage}
                  isBuildingKit={isBuildingKit}
                  hasRequirements={hasReq}
                  onBuildKit={generateApplicationKit}
                  onSetStage={setPipelineStatus}
                />
              )}

              <TabsContent value="jd">
                <div className="flex flex-col gap-4">
                  <JDInputPanel
                    jdText={jdText}
                    setJDText={setJDText}
                    requirements={workspace.requirements}
                    isParsingJD={isParsingJD}
                    streamStatus={streamStatus}
                    onParse={handleParseJD}
                  />
                  {workspace.requirements && (
                    <RequirementsPanel requirements={workspace.requirements} />
                  )}
                  {workspace.requirements && (
                    <InterviewNotesPanel
                      value={workspace.interview_system_prompt}
                      onSave={updateInterviewPrompt}
                    />
                  )}
                </div>
              </TabsContent>

              <TabsContent value="research">
                <ResearchPanel
                  research={workspace.company_research ?? null}
                  paste={workspace.research_paste ?? ""}
                  isResearching={isResearching}
                  company={workspace.requirements?.company}
                  streamStatus={streamStatus}
                  onRun={runResearch}
                  onPasteChange={setResearchPaste}
                  onBriefChange={updateCompanyBrief}
                />
              </TabsContent>

              <TabsContent value="cv">
                <CVEditor
                  sections={baseCV}
                  resumeDoc={baseCVDoc}
                  loading={baseCVLoading}
                  loadError={baseCVError}
                  onReload={reloadBaseCV}
                  onSave={handleSaveCV}
                  onPersistDoc={persistBaseCVDoc}
                />
              </TabsContent>

              <TabsContent value="gaps">
                <GapAnalysis
                  gaps={workspace.gaps}
                  isAnalyzing={isAnalyzingGaps}
                  hasRequirements={!!workspace.requirements}
                  hasCv={hasCv}
                  onAnalyze={analyzeGaps}
                />
              </TabsContent>

              {/* forceMount keeps these panels alive across tab switches so a
                  rendered export preview isn't destroyed when the user leaves
                  and returns. radix hides inactive content via the `hidden`
                  attribute (display:none), which preserves component state +
                  the loaded iframe. */}
              <TabsContent value="tailor" forceMount className="data-[state=inactive]:hidden">
                <BulletReviewPanel
                  bullets={workspace.tailored_bullets ?? []}
                  cvVariant={workspace.cv_variant ?? []}
                  cvVariantDoc={workspace.cv_variant_doc}
                  tailoredTitle={workspace.tailored_titles?.headline}
                  onTitleChange={updateTailoredTitle}
                  tailoredSkills={workspace.tailored_skills}
                  onSkillsChange={updateTailoredSkills}
                  tailoredSummary={workspace.tailored_summary}
                  onSummaryChange={updateTailoredSummary}
                  isTailoring={isTailoring}
                  hasRequirements={!!workspace.requirements}
                  hasCv={hasCv}
                  onGenerate={generateTailoredBullets}
                  onAccept={acceptBullet}
                  onReject={rejectBullet}
                  onAcceptAll={acceptAllBullets}
                  applicationId={workspace.backend_application_id}
                />
              </TabsContent>

              <TabsContent value="cover">
                <CoverLetterPanel
                  coverLetter={workspace.cover_letter ?? null}
                  isGenerating={isGeneratingCoverLetter}
                  hasRequirements={hasReq}
                  hasResearch={hasResearch}
                  streamStatus={streamStatus}
                  applicationId={workspace.backend_application_id}
                  onGenerate={generateCoverLetter}
                  onDocChange={updateCoverLetterDoc}
                />
              </TabsContent>

              <TabsContent value="followup">
                <FollowUpPanel
                  plan={workspace.followups ?? null}
                  isPlanning={isPlanningFollowups}
                  hasRequirements={hasReq}
                  streamStatus={streamStatus}
                  onGenerate={generateFollowUps}
                  onToggle={toggleFollowUp}
                  onDraftChange={updateFollowUpDraft}
                />
              </TabsContent>
            </div>
          </ScrollArea>
        </Tabs>
      </div>
    </div>
  );
};
