import { useCallback, useEffect, useState } from "react";
import { useApp } from "@/contexts";
import {
  parseJD as parseJDFn,
  findRelatedProjects as findRelatedProjectsFn,
  generateSolutionBrief as generateSolutionBriefFn,
  generateArchitectureDiagram as generateArchitectureDiagramFn,
  generateProposal as generateProposalFn,
  answerScreeningQuestions as answerScreeningQuestionsFn,
} from "@/lib/functions";
import {
  loadUpworkWorkspaces,
  saveUpworkWorkspace,
  deleteUpworkWorkspace as deleteUpworkWsFn,
} from "@/lib/storage";
import { shouldUseManagedApi } from "@/lib/functions/managed-api";
import {
  appendEvent,
  createApplication,
  createProposal,
  flushEventQueue,
  getLatestBaseResumeDoc,
} from "@/lib/backend";
import type {
  Proposal,
  ProposalLength,
  RelatedProject,
  ResumeDoc,
  ScreeningQA,
  UpworkWorkspace,
} from "@/types";

/** Background backend write — logs failures, never bubbles them to the UI. */
function fireAndForget(label: string, p: Promise<unknown>): void {
  p.catch((err) => {
    // eslint-disable-next-line no-console
    console.warn(`[backend] ${label} failed:`, err);
  });
}

function makeId() {
  return `upwork_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function freshWorkspace(): UpworkWorkspace {
  const now = Date.now();
  return { id: makeId(), jd_raw: "", createdAt: now, updatedAt: now };
}

/** Split pasted screening questions into individual questions. Handles one per
 *  line (with optional "1." / "-" / "•" prefixes) and falls back to splitting a
 *  single run-on line on "?". */
function splitQuestions(raw: string): string[] {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, "").trim())
    .filter(Boolean);
  if (lines.length <= 1 && raw.includes("?")) {
    return raw
      .split(/\?\s*/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (s.endsWith("?") ? s : `${s}?`));
  }
  return lines;
}

/** Compact proof block (summary + top experience + skills) fed to the proposal
 *  generator so it grounds claims in the candidate's real material. Mirrors the
 *  job-mode helper. */
function buildCandidateProof(doc: ResumeDoc | null): string {
  if (!doc) return "";
  const lines: string[] = [];
  if (doc.summary) lines.push(doc.summary.trim());
  for (const e of doc.experience.slice(0, 2)) {
    lines.push(
      `${e.role} @ ${e.company}: ${(e.bullets ?? []).slice(0, 3).join(" | ")}`
    );
  }
  if (doc.skills.length) {
    lines.push(
      "Skills: " + doc.skills.flatMap((g) => g.items).slice(0, 20).join(", ")
    );
  }
  return lines.filter(Boolean).join("\n");
}

export const useUpworkWorkspace = () => {
  const { selectedAIProvider, allAiProviders } = useApp();
  const [workspace, setWorkspace] = useState<UpworkWorkspace>(freshWorkspace);
  const [allWorkspaces, setAllWorkspaces] = useState<UpworkWorkspace[]>([]);
  const [jdText, setJDText] = useState("");

  const [baseCVDoc, setBaseCVDoc] = useState<ResumeDoc | null>(null);

  const [isParsing, setIsParsing] = useState(false);
  const [isBuildingApproach, setIsBuildingApproach] = useState(false);
  const [isDiagramming, setIsDiagramming] = useState(false);
  const [isGeneratingProposal, setIsGeneratingProposal] = useState(false);
  const [isAnsweringQuestions, setIsAnsweringQuestions] = useState(false);
  const [streamStatus, setStreamStatus] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Same provider-resolution pattern as useJobWorkspace / useCompletion so the
  // env-backed api_key auto-fill in fetchAIResponse triggers correctly.
  const resolveProvider = useCallback(() => {
    const id = selectedAIProvider.provider;
    if (id) return allAiProviders.find((p) => p.id === id);
    return (
      allAiProviders.find((p) => p.id === "deepseek") ||
      allAiProviders.find((p) => p.id === "openai") ||
      allAiProviders[0]
    );
  }, [allAiProviders, selectedAIProvider.provider]);

  const resolveAIParams = useCallback(async () => {
    const useManagedApi = await shouldUseManagedApi();
    const provider = useManagedApi ? undefined : resolveProvider();
    const effectiveSelectedProvider = provider?.id
      ? { ...selectedAIProvider, provider: provider.id }
      : selectedAIProvider;
    return { provider, effectiveSelectedProvider };
  }, [resolveProvider, selectedAIProvider]);

  const syncWorkspaces = useCallback(() => {
    setAllWorkspaces(loadUpworkWorkspaces());
  }, []);

  // Drain any events queued offline on the last run. Best-effort.
  useEffect(() => {
    fireAndForget("flushEventQueue (mount)", flushEventQueue());
  }, []);

  // Load saved workspaces on mount.
  useEffect(() => {
    syncWorkspaces();
  }, [syncWorkspaces]);

  // Load the base CV from the backend on mount — same single-source-of-truth as
  // Job mode. Used as the candidate's real proof material in the proposal.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const doc = await getLatestBaseResumeDoc();
        if (!cancelled) setBaseCVDoc(doc);
      } catch (err) {
        console.warn("[upwork] base CV load failed:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const updateAndPersist = useCallback(
    (updates: Partial<UpworkWorkspace>) => {
      setWorkspace((prev) => {
        const updated = { ...prev, ...updates, updatedAt: Date.now() };
        saveUpworkWorkspace(updated);
        return updated;
      });
      syncWorkspaces();
    },
    [syncWorkspaces]
  );

  /** Persist the user's optional "angle / relevant context" note. */
  const setAngle = useCallback(
    (angle: string) => {
      updateAndPersist({ angle });
    },
    [updateAndPersist]
  );

  /** Toggle whether the saved base CV is used as proof for this gig. */
  const setUseCv = useCallback(
    (use_cv: boolean) => {
      updateAndPersist({ use_cv });
    },
    [updateAndPersist]
  );

  /** CV proof for this gig — empty when the user turned the CV off. */
  const cvProof = workspace.use_cv === false ? "" : buildCandidateProof(baseCVDoc);

  // ===========================================================================
  // 1. Parse the Upwork posting (reuses the JD parser — company will be empty)
  // ===========================================================================

  const parsePosting = useCallback(async () => {
    if (!jdText.trim()) {
      setError("Paste the Upwork job post first.");
      return;
    }
    setIsParsing(true);
    setError(null);
    setStreamStatus("");
    try {
      const { provider, effectiveSelectedProvider } = await resolveAIParams();
      const requirements = await parseJDFn(
        jdText,
        provider,
        effectiveSelectedProvider,
        (chunk) => setStreamStatus((prev) => prev + chunk)
      );

      // Create the Application row on first parse (one application per gig) so
      // the proposal + events can attach to it. Awaited for the returned id.
      let backend_application_id = workspace.backend_application_id;
      if (!backend_application_id) {
        try {
          const app = await createApplication({
            jd_raw: jdText,
            // Upwork posts have no company — leave it null.
            company: null,
            role: requirements.role || null,
            requirements: requirements as unknown as Record<string, unknown>,
          });
          backend_application_id = app.id;
        } catch (err) {
          console.warn(
            "[backend] createApplication failed; continuing local-only:",
            err
          );
        }
      }

      fireAndForget(
        "event upwork_job_parsed",
        appendEvent({
          kind: "upwork_job_parsed",
          application_id: backend_application_id ?? null,
          payload: {
            role: requirements.role,
            required_count: requirements.required.length,
            keywords_count: requirements.keywords.length,
          },
        })
      );

      updateAndPersist({ jd_raw: jdText, requirements, backend_application_id });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to parse the job post");
    } finally {
      setIsParsing(false);
      setStreamStatus("");
    }
  }, [jdText, workspace.backend_application_id, resolveAIParams, updateAndPersist]);

  // ===========================================================================
  // 2. Related open-source projects to clone
  // ===========================================================================

  // Build the domain-specific solution brief (challenges → approach → proof)
  // AND find clonable open-source projects in one pass. The brief is the spine
  // of a winning proposal; the projects are the PoC / portfolio path.
  const runApproach = useCallback(async () => {
    if (!workspace.requirements) {
      setError("Parse the job post first.");
      return;
    }
    setIsBuildingApproach(true);
    setError(null);
    setStreamStatus("");
    try {
      const { provider, effectiveSelectedProvider } = await resolveAIParams();

      const brief = await generateSolutionBriefFn(
        workspace.requirements,
        workspace.jd_raw,
        provider,
        effectiveSelectedProvider,
        (chunk) => setStreamStatus((prev) => prev + chunk)
      );
      updateAndPersist({ solution_brief: brief });

      setStreamStatus("");
      const { projects, sources } = await findRelatedProjectsFn(
        workspace.requirements,
        workspace.angle ?? "",
        provider,
        effectiveSelectedProvider,
        (chunk) => setStreamStatus((prev) => prev + chunk)
      );
      updateAndPersist({
        projects: { projects, sources, generatedAt: Date.now() },
      });

      fireAndForget(
        "event approach_built",
        appendEvent({
          kind: "approach_built",
          application_id: workspace.backend_application_id ?? null,
          payload: {
            challenges: brief.challenges.length,
            approach_steps: brief.approach.length,
            projects: projects.length,
          },
        })
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to build approach");
    } finally {
      setIsBuildingApproach(false);
      setStreamStatus("");
    }
  }, [
    workspace.requirements,
    workspace.jd_raw,
    workspace.angle,
    workspace.backend_application_id,
    resolveAIParams,
    updateAndPersist,
  ]);

  /** Edit the related-projects list in place (e.g. remove an irrelevant one). */
  const updateProjects = useCallback(
    (projects: RelatedProject[]) => {
      if (!workspace.projects) return;
      updateAndPersist({
        projects: { ...workspace.projects, projects },
      });
    },
    [workspace.projects, updateAndPersist]
  );

  /** Generate a domain-specific architecture diagram (Mermaid) to attach to the
   *  proposal. Grounded in the solution brief + job post. */
  const generateDiagram = useCallback(async () => {
    if (!workspace.requirements) {
      setError("Parse the job post first.");
      return;
    }
    setIsDiagramming(true);
    setError(null);
    setStreamStatus("");
    try {
      const { provider, effectiveSelectedProvider } = await resolveAIParams();
      const mermaid = await generateArchitectureDiagramFn(
        workspace.requirements,
        workspace.jd_raw,
        workspace.solution_brief ?? null,
        provider,
        effectiveSelectedProvider,
        (chunk) => setStreamStatus((prev) => prev + chunk)
      );
      updateAndPersist({ architecture: { mermaid, generatedAt: Date.now() } });
      fireAndForget(
        "event diagram_generated",
        appendEvent({
          kind: "diagram_generated",
          application_id: workspace.backend_application_id ?? null,
          payload: { used_brief: !!workspace.solution_brief },
        })
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to generate diagram");
    } finally {
      setIsDiagramming(false);
      setStreamStatus("");
    }
  }, [
    workspace.requirements,
    workspace.jd_raw,
    workspace.solution_brief,
    workspace.backend_application_id,
    resolveAIParams,
    updateAndPersist,
  ]);

  // ===========================================================================
  // 3. Proposal generation
  // ===========================================================================

  // Persist the full current submission as one (append-style) proposals row:
  // openers + body + screening together, so the newest row is always complete.
  // Skips the write when there's no application id or no proposal body yet
  // (the backend requires a non-empty body).
  const persistProposalRow = useCallback(
    (
      proposal: Proposal | null,
      screening: ScreeningQA[],
      applicationId?: string
    ) => {
      if (!applicationId || !proposal || !proposal.body.trim()) return;
      fireAndForget(
        "createProposal",
        createProposal(applicationId, {
          openers: proposal.openers,
          selected_opener: proposal.selected_opener,
          body: proposal.body,
          strategy: proposal.strategy,
          proposal_length: proposal.length,
          angle: workspace.angle ?? null,
          projects: workspace.projects?.projects ?? [],
          screening,
        })
      );
    },
    [workspace.angle, workspace.projects]
  );

  const generateProposal = useCallback(
    async (length: ProposalLength) => {
      if (!workspace.requirements) {
        setError("Parse the job post first.");
        return;
      }
      setIsGeneratingProposal(true);
      setError(null);
      setStreamStatus("");
      try {
        const { provider, effectiveSelectedProvider } = await resolveAIParams();
        const { openers, body } = await generateProposalFn(
          workspace.requirements,
          workspace.jd_raw,
          cvProof,
          workspace.projects?.projects ?? [],
          workspace.solution_brief ?? null,
          workspace.angle ?? "",
          length,
          provider,
          effectiveSelectedProvider,
          (chunk) => setStreamStatus((prev) => prev + chunk)
        );

        const proposal: Proposal = {
          openers,
          selected_opener: 0,
          body,
          strategy: "aida",
          length,
          generatedAt: Date.now(),
        };
        updateAndPersist({ proposal });
        persistProposalRow(
          proposal,
          workspace.screening?.items ?? [],
          workspace.backend_application_id
        );

        fireAndForget(
          "event proposal_generated",
          appendEvent({
            kind: "proposal_generated",
            application_id: workspace.backend_application_id ?? null,
            payload: {
              openers: openers.length,
              length,
              used_projects: (workspace.projects?.projects ?? []).length > 0,
              used_brief: !!workspace.solution_brief,
              used_cv: cvProof !== "",
            },
          })
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to generate proposal");
      } finally {
        setIsGeneratingProposal(false);
        setStreamStatus("");
      }
    },
    [
      workspace.requirements,
      workspace.jd_raw,
      workspace.angle,
      workspace.projects,
      workspace.solution_brief,
      workspace.screening,
      workspace.backend_application_id,
      cvProof,
      resolveAIParams,
      updateAndPersist,
      persistProposalRow,
    ]
  );

  /** Pick which opener variant to use. Re-persists to the backend so the stored
   *  row reflects the user's choice. */
  const selectOpener = useCallback(
    (index: number) => {
      if (!workspace.proposal) return;
      const proposal = { ...workspace.proposal, selected_opener: index };
      updateAndPersist({ proposal });
      persistProposalRow(
        proposal,
        workspace.screening?.items ?? [],
        workspace.backend_application_id
      );
    },
    [
      workspace.proposal,
      workspace.screening,
      workspace.backend_application_id,
      updateAndPersist,
      persistProposalRow,
    ]
  );

  /** Edit an opener variant's text in place. */
  const updateOpener = useCallback(
    (index: number, text: string) => {
      if (!workspace.proposal) return;
      const openers = workspace.proposal.openers.slice();
      openers[index] = text;
      updateAndPersist({ proposal: { ...workspace.proposal, openers } });
    },
    [workspace.proposal, updateAndPersist]
  );

  /** Edit the proposal body in place. */
  const updateProposalBody = useCallback(
    (body: string) => {
      if (!workspace.proposal) return;
      updateAndPersist({ proposal: { ...workspace.proposal, body } });
    },
    [workspace.proposal, updateAndPersist]
  );

  // ===========================================================================
  // 4. Screening / follow-up questions
  // ===========================================================================

  /** Persist the raw pasted screening questions (so they survive reloads). */
  const setScreeningQuestionsRaw = useCallback(
    (raw: string) => {
      updateAndPersist({ screening_questions_raw: raw });
    },
    [updateAndPersist]
  );

  const generateAnswers = useCallback(async () => {
    if (!workspace.requirements) {
      setError("Parse the job post first.");
      return;
    }
    const questions = splitQuestions(workspace.screening_questions_raw ?? "");
    if (questions.length === 0) {
      setError("Paste the Upwork screening questions first.");
      return;
    }
    setIsAnsweringQuestions(true);
    setError(null);
    setStreamStatus("");
    try {
      const { provider, effectiveSelectedProvider } = await resolveAIParams();
      const items = await answerScreeningQuestionsFn(
        questions,
        workspace.requirements,
        cvProof,
        workspace.projects?.projects ?? [],
        workspace.solution_brief ?? null,
        workspace.proposal?.body ?? "",
        workspace.angle ?? "",
        provider,
        effectiveSelectedProvider,
        (chunk) => setStreamStatus((prev) => prev + chunk)
      );

      const screening = { items, generatedAt: Date.now() };
      updateAndPersist({ screening });
      persistProposalRow(
        workspace.proposal ?? null,
        items,
        workspace.backend_application_id
      );

      fireAndForget(
        "event screening_answered",
        appendEvent({
          kind: "screening_answered",
          application_id: workspace.backend_application_id ?? null,
          payload: { count: items.length },
        })
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to answer questions");
    } finally {
      setIsAnsweringQuestions(false);
      setStreamStatus("");
    }
  }, [
    workspace.requirements,
    workspace.screening_questions_raw,
    workspace.projects,
    workspace.solution_brief,
    workspace.proposal,
    workspace.angle,
    workspace.backend_application_id,
    cvProof,
    resolveAIParams,
    updateAndPersist,
    persistProposalRow,
  ]);

  /** Edit a screening answer in place. */
  const updateScreeningAnswer = useCallback(
    (index: number, answer: string) => {
      if (!workspace.screening) return;
      const items = workspace.screening.items.slice();
      if (!items[index]) return;
      items[index] = { ...items[index], answer };
      updateAndPersist({ screening: { ...workspace.screening, items } });
    },
    [workspace.screening, updateAndPersist]
  );

  // ===========================================================================
  // Workspace management
  // ===========================================================================

  const newWorkspace = useCallback(() => {
    const ws = freshWorkspace();
    setWorkspace(ws);
    setJDText("");
    setError(null);
    setStreamStatus("");
  }, []);

  const loadWorkspace = useCallback((id: string) => {
    const ws = loadUpworkWorkspaces().find((w) => w.id === id);
    if (ws) {
      setWorkspace(ws);
      setJDText(ws.jd_raw ?? "");
      setError(null);
      setStreamStatus("");
    }
  }, []);

  const deleteWorkspace = useCallback(
    (id: string) => {
      deleteUpworkWsFn(id);
      syncWorkspaces();
      setWorkspace((prev) => (prev.id === id ? freshWorkspace() : prev));
    },
    [syncWorkspaces]
  );

  return {
    jdText,
    setJDText,
    workspace,
    allWorkspaces,
    baseCVDoc,
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
  };
};
