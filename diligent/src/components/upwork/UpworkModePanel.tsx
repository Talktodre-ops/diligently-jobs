import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
  Button,
  ScrollArea,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui";
import { useUpworkWorkspace } from "@/hooks";
import { UpworkJobPanel } from "./UpworkJobPanel";
import { ApproachPanel } from "./ApproachPanel";
import { ProposalPanel } from "./ProposalPanel";
import { ScreeningPanel } from "./ScreeningPanel";

type ActiveTab = "post" | "approach" | "proposal" | "questions";

export const UpworkModePanel = () => {
  const {
    jdText,
    setJDText,
    workspace,
    allWorkspaces,
    isParsing,
    isBuildingApproach,
    isDiagramming,
    isGeneratingProposal,
    isAnsweringQuestions,
    streamStatus,
    error,
    setAngle,
    setUseCv,
    parsePosting,
    runApproach,
    updateProjects,
    generateDiagram,
    generateProposal,
    selectOpener,
    updateOpener,
    updateProposalBody,
    setScreeningQuestionsRaw,
    generateAnswers,
    updateScreeningAnswer,
    newWorkspace,
    loadWorkspace,
    deleteWorkspace,
  } = useUpworkWorkspace();

  const [activeTab, setActiveTab] = useState<ActiveTab>("post");

  const hasReq = !!workspace.requirements;
  const projects = workspace.projects?.projects ?? [];
  const hasProjects = projects.length > 0;
  const hasApproach =
    !!workspace.solution_brief || hasProjects || !!workspace.architecture;
  const hasProposal = !!workspace.proposal;
  const hasScreening = (workspace.screening?.items.length ?? 0) > 0;
  const isStreaming =
    isParsing ||
    isBuildingApproach ||
    isDiagramming ||
    isGeneratingProposal ||
    isAnsweringQuestions;

  const handleParse = async () => {
    await parsePosting();
    // Move forward to the approach step after a parse attempt.
    if (jdText.trim()) setActiveTab("approach");
  };

  const handleRemoveProject = (index: number) => {
    updateProjects(projects.filter((_, i) => i !== index));
  };

  return (
    <div className="flex w-screen overflow-hidden" style={{ maxHeight: "70vh" }}>
      {/* Sidebar — previous proposal workspaces */}
      <div className="w-44 shrink-0 border-r border-input/50 flex flex-col">
        <div className="flex items-center justify-between px-3 py-2 border-b border-input/30">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Proposals
          </span>
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            onClick={newWorkspace}
            title="New proposal"
          >
            <Plus className="h-3 w-3" />
          </Button>
        </div>

        <ScrollArea className="flex-1">
          <div className="flex flex-col gap-0.5 p-1.5">
            {allWorkspaces.length === 0 && (
              <p className="text-xs text-muted-foreground italic px-2 py-1">
                No saved proposals
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
                      {ws.requirements?.role || "Untitled gig"}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {ws.proposal ? "Proposal ready" : "Draft"}
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
                    title="Delete proposal"
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))}
          </div>
        </ScrollArea>
      </div>

      {/* Main content */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as ActiveTab)}
          className="flex flex-col flex-1 min-h-0 overflow-hidden"
        >
          <div className="flex items-center justify-between gap-2 px-3 pt-2 pb-0 border-b border-input/30">
            <div className="flex-1 min-w-0 overflow-x-auto overflow-y-hidden [scrollbar-width:thin]">
              <TabsList className="h-8 w-max">
                <TabsTrigger value="post" className="text-xs px-2.5">
                  1 · Job Post
                  {hasReq && <span className="ml-1 text-emerald-500">✓</span>}
                </TabsTrigger>
                <TabsTrigger value="approach" className="text-xs px-2.5">
                  2 · Approach
                  {hasApproach && (
                    <span className="ml-1 text-emerald-500">✓</span>
                  )}
                </TabsTrigger>
                <TabsTrigger value="proposal" className="text-xs px-2.5">
                  3 · Proposal
                  {hasProposal && (
                    <span className="ml-1 text-emerald-500">✓</span>
                  )}
                </TabsTrigger>
                <TabsTrigger value="questions" className="text-xs px-2.5">
                  4 · Questions
                  {hasScreening && (
                    <span className="ml-1 text-emerald-500">✓</span>
                  )}
                </TabsTrigger>
              </TabsList>
            </div>

            {workspace.requirements?.role && (
              <span className="text-xs text-muted-foreground truncate max-w-36 shrink-0">
                {workspace.requirements.role}
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

              {isStreaming && streamStatus && (
                <div className="mb-3 rounded-xl border border-input/30 bg-muted/30 px-3 py-2 text-xs text-muted-foreground line-clamp-2">
                  {streamStatus}
                </div>
              )}

              <TabsContent value="post">
                <UpworkJobPanel
                  jdText={jdText}
                  setJDText={setJDText}
                  angle={workspace.angle ?? ""}
                  onAngleChange={setAngle}
                  useCv={workspace.use_cv !== false}
                  onUseCvChange={setUseCv}
                  requirements={workspace.requirements}
                  isParsing={isParsing}
                  onParse={handleParse}
                />
              </TabsContent>

              <TabsContent value="approach">
                <ApproachPanel
                  brief={workspace.solution_brief ?? null}
                  research={workspace.projects ?? null}
                  architecture={workspace.architecture ?? null}
                  isBuilding={isBuildingApproach}
                  isDiagramming={isDiagramming}
                  hasRequirements={hasReq}
                  streamStatus={streamStatus}
                  onRun={runApproach}
                  onGenerateDiagram={generateDiagram}
                  onRemoveProject={handleRemoveProject}
                />
              </TabsContent>

              <TabsContent value="proposal">
                <ProposalPanel
                  proposal={workspace.proposal ?? null}
                  isGenerating={isGeneratingProposal}
                  hasRequirements={hasReq}
                  hasProjects={hasProjects}
                  streamStatus={streamStatus}
                  onGenerate={generateProposal}
                  onSelectOpener={selectOpener}
                  onUpdateOpener={updateOpener}
                  onUpdateBody={updateProposalBody}
                />
              </TabsContent>

              <TabsContent value="questions">
                <ScreeningPanel
                  questionsRaw={workspace.screening_questions_raw ?? ""}
                  onQuestionsChange={setScreeningQuestionsRaw}
                  screening={workspace.screening ?? null}
                  isAnswering={isAnsweringQuestions}
                  hasRequirements={hasReq}
                  streamStatus={streamStatus}
                  onGenerate={generateAnswers}
                  onUpdateAnswer={updateScreeningAnswer}
                />
              </TabsContent>
            </div>
          </ScrollArea>
        </Tabs>
      </div>
    </div>
  );
};
