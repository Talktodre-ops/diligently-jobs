import { useCallback, useEffect, useState } from "react";
import { useApp } from "@/contexts";
import {
  parseJD as parseJDFn,
  analyzeGaps as analyzeGapsFn,
  generateTailoredBullets as generateTailoredBulletsFn,
  tailorSkills as tailorSkillsFn,
  tailorTitles as tailorTitlesFn,
  cleanHeadline,
  tailorSummary as tailorSummaryFn,
  researchCompany as researchCompanyFn,
  generateCoverLetter as generateCoverLetterFn,
  generateFollowUps as generateFollowUpsFn,
  resumeDocToFlatSections,
} from "@/lib/functions";
import {
  saveWorkspace,
  loadWorkspaces,
  deleteWorkspace as deleteWsFn,
} from "@/lib/storage";
import { shouldUseManagedApi } from "@/lib/functions/managed-api";
import {
  appendEvent,
  createApplication,
  createCompanyResearch,
  createCvVersion,
  flushEventQueue,
  getLatestBaseResumeDoc,
} from "@/lib/backend";
import type {
  ApplicationStage,
  CompanyBrief,
  CompanyResearch,
  CoverLetter,
  CoverLetterDoc,
  CVSection,
  FollowUp,
  FollowUpPlan,
  JobWorkspace,
  ResumeDoc,
  SkillGroup,
  TailoredBullet,
  TailoredTitles,
} from "@/types";

/** Payload shape produced by CVEditor on Save. Doc variant routes through the
 *  templated LaTeX export; flat variant keeps the legacy static fallback. */
export type CvSavePayload =
  | { kind: "doc"; doc: ResumeDoc; flat: CVSection[] }
  | { kind: "flat"; sections: CVSection[] };

/**
 * Run a backend write in the background. Logs failures but never bubbles them
 * to the UI — backend sync is best-effort, the local workspace always works.
 * Events that fail get queued by the client layer; non-event writes (creating
 * an Application, cv_versions row) are simply skipped on failure and the
 * workspace stays untracked until the next sync attempt.
 */
function fireAndForget(label: string, p: Promise<unknown>): void {
  p.catch((err) => {
    // eslint-disable-next-line no-console
    console.warn(`[backend] ${label} failed:`, err);
  });
}

function makeId() {
  return `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function freshWorkspace(): JobWorkspace {
  const now = Date.now();
  return {
    id: makeId(),
    jd_raw: "",
    cv_snapshot: [],
    gaps: [],
    tailored_bullets: [],
    cv_variant: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** Accepted rewrites (original → rewrite) plus the set of originals the tailor
 *  cut as irrelevant. Shared by both variant builders. */
function acceptedEdits(bullets: TailoredBullet[]): {
  rewrites: Map<string, string>;
  dropped: Set<string>;
} {
  const rewrites = new Map<string, string>();
  const dropped = new Set<string>();
  for (const b of bullets) {
    if (b.status !== "accepted") continue;
    if (b.drop) dropped.add(b.original);
    else rewrites.set(b.original, b.rewrite);
  }
  return { rewrites, dropped };
}

function buildCvVariant(
  cvSections: CVSection[],
  bullets: TailoredBullet[]
): CVSection[] {
  const { rewrites, dropped } = acceptedEdits(bullets);
  return cvSections.map((s) => ({
    ...s,
    bullets: s.bullets.flatMap((b) =>
      dropped.has(b) ? [] : [rewrites.get(b) ?? b]
    ),
  }));
}

/**
 * Structured analogue of buildCvVariant: clone the base ResumeDoc, swap accepted
 * rewrites into it (matched by the flat key `resumeDocToFlatSections` produced),
 * and drop the experience bullets / projects the tailor cut as irrelevant to the
 * target domain. Covers summary, experience bullets, skill groups, and projects.
 */
function buildResumeDocVariant(
  doc: ResumeDoc,
  bullets: TailoredBullet[],
  tailoredSkills?: SkillGroup[] | null,
  tailoredTitles?: TailoredTitles | null,
  tailoredSummary?: string | null
): ResumeDoc {
  const { rewrites: accepted, dropped } = acceptedEdits(bullets);

  // Reframed titles (headline + per-role). Match each reframe to its experience
  // entry by company + original role so it lands on the right row even if the
  // model returns them in a different order. Fall back to positional index when
  // the echo-back fields are missing.
  const roleReframeByKey = new Map<string, string>();
  (tailoredTitles?.roles ?? []).forEach((r, i) => {
    roleReframeByKey.set(`${r.company} ${r.original_role}`, r.role);
    roleReframeByKey.set(`#${i}`, r.role);
  });
  // A generated headline is already cleaned in `tailorTitles`, and a hand-edited
  // one is deliberate — both are used verbatim. Only the base CV's own title is
  // cleaned, as the fallback.
  const reframedHeader =
    tailoredTitles?.headline && tailoredTitles.headline.trim()
      ? { ...doc.header, title: tailoredTitles.headline.trim() }
      : { ...doc.header, title: cleanHeadline(doc.header.title) };

  // When the Skills section was regenerated as coherent groups, use it
  // wholesale — it overrides the per-line flat-key swap.
  const skills: SkillGroup[] =
    tailoredSkills && tailoredSkills.length > 0
      ? tailoredSkills
      : doc.skills.map((g) => {
          // Flat key matches resumeDocToFlatSections: `${label}: ${items}`.
          const flatKey = `${g.label}: ${g.items.join(", ")}`;
          const rw = accepted.get(flatKey);
          if (!rw) return g;
          // Re-parse "Label: a, b, c" back into {label, items}.
          const idx = rw.indexOf(": ");
          if (idx === -1) {
            return { ...g, items: rw.split(",").map((s) => s.trim()).filter(Boolean) };
          }
          return {
            label: rw.slice(0, idx).trim(),
            items: rw
              .slice(idx + 2)
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          };
        });

  const projects = doc.projects.flatMap((p) => {
    // Flat key matches resumeDocToFlatSections: `${name}: ${desc}: ${link.display}`.
    const head = p.name ? `${p.name}: ` : "";
    const linkSuffix = p.link ? `: ${p.link.display}` : "";
    const flatKey = `${head}${p.description}${linkSuffix}`;
    if (dropped.has(flatKey)) return []; // project irrelevant to the target role
    const rw = accepted.get(flatKey);
    if (!rw) return [p];
    // Recover the description by stripping the name prefix / link suffix the
    // LLM (usually) preserved. If it restructured, the whole rewrite becomes
    // the description — still better than dropping the tailoring.
    let desc = rw;
    if (p.name && desc.startsWith(`${p.name}: `)) {
      desc = desc.slice(p.name.length + 2);
    }
    if (p.link && desc.endsWith(`: ${p.link.display}`)) {
      desc = desc.slice(0, desc.length - (p.link.display.length + 2));
    }
    return [{ ...p, description: desc.trim() }];
  });

  return {
    ...doc,
    header: reframedHeader,
    // Dedicated tailored summary wins; else the bullet-rewrite of the summary
    // line; else the base summary.
    summary:
      tailoredSummary && tailoredSummary.trim()
        ? tailoredSummary.trim()
        : doc.summary
        ? accepted.get(doc.summary) ?? doc.summary
        : doc.summary,
    experience: doc.experience.map((e, i) => ({
      ...e,
      role:
        roleReframeByKey.get(`${e.company} ${e.role}`) ??
        roleReframeByKey.get(`#${i}`) ??
        e.role,
      // Rewrite kept bullets; drop the ones the tailor cut as off-domain.
      bullets: e.bullets.flatMap((b) =>
        dropped.has(b) ? [] : [accepted.get(b) ?? b]
      ),
    })),
    skills,
    projects,
  };
}

/** "email · linkedin · github · phone" contact line for the letter header. */
function buildCandidateContact(doc: ResumeDoc | null): string | null {
  if (!doc) return null;
  const h = doc.header;
  const parts = [
    h.email,
    h.linkedin?.display,
    h.github?.display,
    h.website?.display,
    h.phone,
  ].filter((x): x is string => !!x && x.trim().length > 0);
  return parts.length ? parts.join(" · ") : null;
}

/** Compact proof block (summary + top experience + skills) fed to the letter
 *  generator so it grounds claims in the candidate's real material. */
function buildCandidateProof(doc: ResumeDoc | null): string {
  if (!doc) return "";
  const lines: string[] = [];
  if (doc.summary) lines.push(doc.summary.trim());
  for (const e of doc.experience.slice(0, 2)) {
    lines.push(`${e.role} @ ${e.company}: ${(e.bullets ?? []).slice(0, 3).join(" | ")}`);
  }
  if (doc.skills.length) {
    lines.push(
      "Skills: " + doc.skills.flatMap((g) => g.items).slice(0, 20).join(", ")
    );
  }
  return lines.filter(Boolean).join("\n");
}

export const useJobWorkspace = () => {
  const { selectedAIProvider, allAiProviders } = useApp();
  const [workspace, setWorkspace] = useState<JobWorkspace>(freshWorkspace);
  // Base CV is DB-sourced — no localStorage. Starts empty and hydrates from
  // the backend on mount. `baseCVLoading` gates the editor UI; `baseCVError`
  // surfaces a failed load or save (no local fallback now, so failures must
  // be visible rather than silently swallowed).
  const [baseCV, setBaseCV] = useState<CVSection[]>([]);
  const [baseCVDoc, setBaseCVDoc] = useState<ResumeDoc | null>(null);
  const [baseCVLoading, setBaseCVLoading] = useState(true);
  const [baseCVError, setBaseCVError] = useState<string | null>(null);
  const [allWorkspaces, setAllWorkspaces] = useState<JobWorkspace[]>(loadWorkspaces);
  const [jdText, setJDText] = useState("");
  const [isParsingJD, setIsParsingJD] = useState(false);
  const [isAnalyzingGaps, setIsAnalyzingGaps] = useState(false);
  const [isTailoring, setIsTailoring] = useState(false);
  const [isResearching, setIsResearching] = useState(false);
  const [isGeneratingCoverLetter, setIsGeneratingCoverLetter] = useState(false);
  const [isPlanningFollowups, setIsPlanningFollowups] = useState(false);
  const [isBuildingKit, setIsBuildingKit] = useState(false);
  const [streamStatus, setStreamStatus] = useState("");
  const [error, setError] = useState<string | null>(null);

  const resolveProvider = useCallback(() => {
    const id = selectedAIProvider.provider;
    if (id) return allAiProviders.find((p) => p.id === id);
    return allAiProviders.find((p) => p.id === "deepseek") ||
      allAiProviders.find((p) => p.id === "openai") ||
      allAiProviders[0];
  }, [allAiProviders, selectedAIProvider.provider]);

  // Mirrors the exact pattern in useCompletion so the env-backed api_key
  // auto-fill in fetchAIResponse triggers correctly for deepseek / openai.
  const resolveAIParams = useCallback(async () => {
    const useManagedApi = await shouldUseManagedApi();
    const provider = useManagedApi ? undefined : resolveProvider();
    const effectiveSelectedProvider = provider?.id
      ? { ...selectedAIProvider, provider: provider.id }
      : selectedAIProvider;
    return { provider, effectiveSelectedProvider };
  }, [resolveProvider, selectedAIProvider]);

  const syncWorkspaces = useCallback(() => {
    setAllWorkspaces(loadWorkspaces());
  }, []);

  // Drain any events that were queued offline on the last run. Best-effort:
  // if the backend is still unreachable we silently leave them queued.
  useEffect(() => {
    fireAndForget("flushEventQueue (mount)", flushEventQueue());
  }, []);

  // Load the base CV from the backend on mount. The DB is the single source
  // of truth — no localStorage cache. If the backend is unreachable the base
  // CV is simply empty until the next successful load (or a fresh upload).
  const loadBaseCvFromDb = useCallback(async () => {
    setBaseCVLoading(true);
    setBaseCVError(null);
    try {
      const doc = await getLatestBaseResumeDoc();
      if (doc) {
        setBaseCVDoc(doc);
        setBaseCV(resumeDocToFlatSections(doc));
      } else {
        setBaseCVDoc(null);
        setBaseCV([]);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[cv] base CV load from DB failed:", msg);
      setBaseCVError(`Couldn't load your CV from the server: ${msg}`);
    } finally {
      setBaseCVLoading(false);
    }
  }, []);

  useEffect(() => {
    loadBaseCvFromDb();
  }, [loadBaseCvFromDb]);

  const updateAndPersist = useCallback(
    (updates: Partial<JobWorkspace>) => {
      setWorkspace((prev) => {
        const updated = { ...prev, ...updates, updatedAt: Date.now() };
        saveWorkspace(updated);
        return updated;
      });
      syncWorkspaces();
    },
    [syncWorkspaces]
  );

  // Rebuild the structured tailored variant when it's missing but a base CV and
  // tailoring both exist, so the export stays on the templated path without a
  // manual regenerate/re-accept.
  useEffect(() => {
    const baseDoc = baseCVDoc ?? workspace.cv_resume_doc ?? null;
    if (!baseDoc || workspace.cv_variant_doc) return;
    const hasTailoring =
      workspace.tailored_bullets.some((b) => b.status === "accepted") ||
      (workspace.tailored_skills?.length ?? 0) > 0 ||
      !!workspace.tailored_titles ||
      !!workspace.tailored_summary;
    if (!hasTailoring) return;
    const cv_variant_doc = buildResumeDocVariant(
      baseDoc,
      workspace.tailored_bullets,
      workspace.tailored_skills,
      workspace.tailored_titles,
      workspace.tailored_summary
    );
    updateAndPersist({ cv_variant_doc });
  }, [
    baseCVDoc,
    workspace.cv_resume_doc,
    workspace.cv_variant_doc,
    workspace.tailored_bullets,
    workspace.tailored_skills,
    workspace.tailored_titles,
    workspace.tailored_summary,
    updateAndPersist,
  ]);

  const parseJD = useCallback(async () => {
    if (!jdText.trim()) {
      setError("Paste a job description first.");
      return;
    }
    setIsParsingJD(true);
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

      // Backend sync — create the Application row on first parse so future
      // events can attach to it. Awaited because we need the returned id.
      let backend_application_id = workspace.backend_application_id;
      if (!backend_application_id) {
        try {
          const app = await createApplication({
            jd_raw: jdText,
            company: requirements.company || null,
            role: requirements.role || null,
            requirements: requirements as unknown as Record<string, unknown>,
          });
          backend_application_id = app.id;
        } catch (err) {
          console.warn("[backend] createApplication failed; continuing local-only:", err);
        }
      } else {
        // We already had an application row — keep its requirements / metadata fresh.
        fireAndForget(
          "patchApplication (re-parse)",
          import("@/lib/backend").then(({ patchApplication }) =>
            patchApplication(backend_application_id!, {
              company: requirements.company || null,
              role: requirements.role || null,
              requirements: requirements as unknown as Record<string, unknown>,
            })
          )
        );
      }

      fireAndForget(
        "event jd_parsed",
        appendEvent({
          kind: "jd_parsed",
          application_id: backend_application_id ?? null,
          payload: {
            role: requirements.role,
            company: requirements.company,
            required_count: requirements.required.length,
            nice_to_have_count: requirements.nice_to_have.length,
            keywords_count: requirements.keywords.length,
          },
        })
      );

      updateAndPersist({ jd_raw: jdText, requirements, backend_application_id });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to parse JD");
    } finally {
      setIsParsingJD(false);
      setStreamStatus("");
    }
  }, [jdText, resolveProvider, selectedAIProvider, updateAndPersist]);

  const analyzeGaps = useCallback(async () => {
    if (!workspace.requirements) {
      setError("Parse the JD first.");
      return;
    }
    const cv = baseCV.length > 0 ? baseCV : workspace.cv_snapshot;
    if (cv.length === 0) {
      setError("Add your CV bullets before analyzing gaps.");
      return;
    }
    setIsAnalyzingGaps(true);
    setError(null);
    setStreamStatus("");
    try {
      const { provider, effectiveSelectedProvider } = await resolveAIParams();
      const gaps = await analyzeGapsFn(
        workspace.requirements,
        cv,
        provider,
        effectiveSelectedProvider,
        (chunk) => setStreamStatus((prev) => prev + chunk)
      );

      const covered = gaps.filter((g) => g.status === "covered").length;
      const partial = gaps.filter((g) => g.status === "partial").length;
      const missing = gaps.filter((g) => g.status === "missing").length;

      fireAndForget(
        "event gaps_analyzed",
        appendEvent({
          kind: "gaps_analyzed",
          application_id: workspace.backend_application_id ?? null,
          payload: { covered, partial, missing, total: gaps.length },
        })
      );

      updateAndPersist({ gaps, cv_snapshot: cv });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to analyze gaps");
    } finally {
      setIsAnalyzingGaps(false);
      setStreamStatus("");
    }
  }, [
    workspace.requirements,
    workspace.cv_snapshot,
    baseCV,
    resolveProvider,
    selectedAIProvider,
    updateAndPersist,
  ]);

  const generateTailoredBullets = useCallback(async () => {
    if (!workspace.requirements) {
      setError("Parse the JD first.");
      return;
    }
    const cv = baseCV.length > 0 ? baseCV : workspace.cv_snapshot;
    if (cv.length === 0) {
      setError("Add your CV bullets before tailoring.");
      return;
    }
    setIsTailoring(true);
    setError(null);
    setStreamStatus("");
    try {
      const { provider, effectiveSelectedProvider } = await resolveAIParams();
      const raw = await generateTailoredBulletsFn(
        workspace.requirements,
        cv,
        provider,
        effectiveSelectedProvider,
        (chunk) => setStreamStatus((prev) => prev + chunk)
      );
      const tailored_bullets: TailoredBullet[] = raw.map((b) => ({
        ...b,
        id: `tb_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        status: "pending" as const,
      }));

      // Structured base doc drives the reframed titles/summary/skills and the
      // structured tailored variant (templated export). Re-hydrate from the DB
      // if it's missing in-session so tailoring never falls back to flat.
      let baseDoc = baseCVDoc ?? workspace.cv_resume_doc ?? null;
      if (!baseDoc) {
        try {
          const dbDoc = await getLatestBaseResumeDoc();
          if (dbDoc) {
            baseDoc = dbDoc;
            setBaseCVDoc(dbDoc);
            updateAndPersist({ cv_resume_doc: dbDoc });
          }
        } catch (err) {
          console.warn("[tailor] structured base CV re-hydrate from DB failed:", err);
        }
      }
      const baseSkills = baseDoc?.skills ?? [];
      let tailored_skills: SkillGroup[] | null = null;
      if (baseSkills.length > 0) {
        try {
          const regen = await tailorSkillsFn(
            workspace.requirements,
            baseSkills,
            provider,
            effectiveSelectedProvider,
            (chunk) => setStreamStatus((prev) => prev + chunk)
          );
          if (regen.length > 0) tailored_skills = regen;
        } catch (err) {
          console.warn("[tailor] skills regeneration failed; keeping base skills:", err);
        }
      }

      // Reframe the headline + per-role job titles toward the target role
      // (aligned reframe — see TAILOR_TITLES_SYSTEM_PROMPT). Needs the
      // structured base doc for the original headline + experience titles.
      // Best-effort: a failure leaves the original titles untouched.
      let tailored_titles: TailoredTitles | null = null;
      if (baseDoc && baseDoc.experience.length > 0) {
        try {
          const titles = await tailorTitlesFn(
            workspace.requirements,
            baseDoc.header.title,
            baseDoc.experience.map((e) => ({ company: e.company, role: e.role })),
            provider,
            effectiveSelectedProvider,
            (chunk) => setStreamStatus((prev) => prev + chunk)
          );
          tailored_titles = titles;
        } catch (err) {
          console.warn("[tailor] title reframing failed; keeping original titles:", err);
        }
      }

      // Regenerate the professional summary with senior positioning tuned to
      // the role. Needs the structured base doc for the summary + experience
      // proof material. Best-effort: a failure keeps the base summary.
      let tailored_summary: string | null = null;
      if (baseDoc) {
        try {
          const summary = await tailorSummaryFn(
            workspace.requirements,
            baseDoc.summary ?? "",
            baseDoc.experience.map((e) => ({
              role: e.role,
              company: e.company,
              bullets: e.bullets,
            })),
            provider,
            effectiveSelectedProvider,
            (chunk) => setStreamStatus((prev) => prev + chunk)
          );
          if (summary && summary.trim()) tailored_summary = summary.trim();
        } catch (err) {
          console.warn("[tailor] summary rewrite failed; keeping base summary:", err);
        }
      }

      fireAndForget(
        "event bullets_generated",
        appendEvent({
          kind: "bullets_generated",
          application_id: workspace.backend_application_id ?? null,
          payload: {
            count: tailored_bullets.length,
            skills_regenerated: tailored_skills !== null,
            titles_reframed: tailored_titles !== null,
            summary_rewritten: tailored_summary !== null,
          },
        })
      );

      updateAndPersist({
        tailored_bullets,
        tailored_skills,
        tailored_titles,
        tailored_summary,
        cv_snapshot: cv,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to generate rewrites");
    } finally {
      setIsTailoring(false);
      setStreamStatus("");
    }
  }, [
    workspace.requirements,
    workspace.cv_snapshot,
    workspace.cv_resume_doc,
    baseCV,
    baseCVDoc,
    resolveProvider,
    selectedAIProvider,
    updateAndPersist,
  ]);

  const setBulletStatus = useCallback(
    (id: string, status: TailoredBullet["status"]) => {
      let snapshot: { bullet?: TailoredBullet; appId?: string } = {};
      setWorkspace((prev) => {
        const tailored_bullets = prev.tailored_bullets.map((b) =>
          b.id === id ? { ...b, status } : b
        );
        const cv = baseCV.length > 0 ? baseCV : prev.cv_snapshot;
        const cv_variant = buildCvVariant(cv, tailored_bullets);
        // Structured variant tracks the same accepted rewrites so the
        // tailored export can route through the templated LaTeX path.
        const baseDoc = baseCVDoc ?? prev.cv_resume_doc ?? null;
        const cv_variant_doc = baseDoc
          ? buildResumeDocVariant(baseDoc, tailored_bullets, prev.tailored_skills, prev.tailored_titles, prev.tailored_summary)
          : null;
        const updated = {
          ...prev,
          tailored_bullets,
          cv_variant,
          cv_variant_doc,
          updatedAt: Date.now(),
        };
        saveWorkspace(updated);
        snapshot.bullet = tailored_bullets.find((b) => b.id === id);
        snapshot.appId = prev.backend_application_id;
        return updated;
      });
      syncWorkspaces();

      if (snapshot.bullet) {
        fireAndForget(
          `event bullet_${status}`,
          appendEvent({
            kind: status === "accepted" ? "bullet_accepted" : "bullet_rejected",
            application_id: snapshot.appId ?? null,
            payload: {
              bullet_id: snapshot.bullet.id,
              section: snapshot.bullet.section,
              original: snapshot.bullet.original,
              rewrite: snapshot.bullet.rewrite,
            },
          })
        );
      }
    },
    [baseCV, baseCVDoc, syncWorkspaces]
  );

  const acceptBullet = useCallback(
    (id: string) => setBulletStatus(id, "accepted"),
    [setBulletStatus]
  );

  const rejectBullet = useCallback(
    (id: string) => setBulletStatus(id, "rejected"),
    [setBulletStatus]
  );

  const acceptAllBullets = useCallback(() => {
    let snapshot: {
      cvVariant?: CVSection[];
      cvVariantDoc?: ResumeDoc | null;
      appId?: string;
      acceptedCount?: number;
    } = {};
    setWorkspace((prev) => {
      const tailored_bullets = prev.tailored_bullets.map((b) => ({
        ...b,
        status: "accepted" as const,
      }));
      const cv = baseCV.length > 0 ? baseCV : prev.cv_snapshot;
      const cv_variant = buildCvVariant(cv, tailored_bullets);
      const baseDoc = baseCVDoc ?? prev.cv_resume_doc ?? null;
      const cv_variant_doc = baseDoc
        ? buildResumeDocVariant(baseDoc, tailored_bullets, prev.tailored_skills, prev.tailored_titles, prev.tailored_summary)
        : null;
      const updated = {
        ...prev,
        tailored_bullets,
        cv_variant,
        cv_variant_doc,
        updatedAt: Date.now(),
      };
      saveWorkspace(updated);
      snapshot.cvVariant = cv_variant;
      snapshot.cvVariantDoc = cv_variant_doc;
      snapshot.appId = prev.backend_application_id;
      snapshot.acceptedCount = tailored_bullets.length;
      return updated;
    });
    syncWorkspaces();

    // Persist the variant on the backend as an immutable cv_versions row.
    // Prefer the structured doc so re-renders route through the templated
    // LaTeX path; fall back to flat sections for legacy (no base doc).
    const sectionsPayload: unknown = snapshot.cvVariantDoc ?? snapshot.cvVariant;
    if (
      (snapshot.cvVariantDoc) ||
      (snapshot.cvVariant && snapshot.cvVariant.length > 0)
    ) {
      fireAndForget(
        "createCvVersion (accept-all)",
        createCvVersion({
          application_id: snapshot.appId ?? null,
          sections: sectionsPayload as never,
          label: snapshot.cvVariantDoc
            ? "tailored-accept-all-structured"
            : "tailored-accept-all",
        })
      );
      fireAndForget(
        "event cv_variant_saved",
        appendEvent({
          kind: "cv_variant_saved",
          application_id: snapshot.appId ?? null,
          payload: {
            trigger: "accept_all",
            accepted: snapshot.acceptedCount,
            structured: snapshot.cvVariantDoc !== null,
          },
        })
      );
    }
  }, [baseCV, baseCVDoc, syncWorkspaces]);

  /**
   * Edit the regenerated Skills section in place. Rebuilds the tailored
   * variant doc so the export reflects the edits immediately.
   */
  const updateTailoredSkills = useCallback(
    (skills: SkillGroup[]) => {
      setWorkspace((prev) => {
        const baseDoc = baseCVDoc ?? prev.cv_resume_doc ?? null;
        const cv_variant_doc = baseDoc
          ? buildResumeDocVariant(baseDoc, prev.tailored_bullets, skills, prev.tailored_titles, prev.tailored_summary)
          : null;
        const updated = {
          ...prev,
          tailored_skills: skills,
          cv_variant_doc,
          updatedAt: Date.now(),
        };
        saveWorkspace(updated);
        return updated;
      });
      syncWorkspaces();
    },
    [baseCVDoc, syncWorkspaces]
  );

  /**
   * Edit the regenerated professional summary in place. Rebuilds the tailored
   * variant doc so the export reflects the edit immediately.
   */
  const updateTailoredSummary = useCallback(
    (summary: string) => {
      setWorkspace((prev) => {
        const baseDoc = baseCVDoc ?? prev.cv_resume_doc ?? null;
        const cv_variant_doc = baseDoc
          ? buildResumeDocVariant(baseDoc, prev.tailored_bullets, prev.tailored_skills, prev.tailored_titles, summary)
          : null;
        const updated = {
          ...prev,
          tailored_summary: summary,
          cv_variant_doc,
          updatedAt: Date.now(),
        };
        saveWorkspace(updated);
        return updated;
      });
      syncWorkspaces();
    },
    [baseCVDoc, syncWorkspaces]
  );

  /**
   * Edit the headline/job title in place. Rebuilds the tailored variant doc so
   * the export reflects the edit immediately. Kept verbatim — a hand-typed
   * title is not run through `cleanHeadline`.
   */
  const updateTailoredTitle = useCallback(
    (headline: string) => {
      setWorkspace((prev) => {
        const baseDoc = baseCVDoc ?? prev.cv_resume_doc ?? null;
        const tailored_titles: TailoredTitles = {
          headline,
          roles: prev.tailored_titles?.roles ?? [],
        };
        const cv_variant_doc = baseDoc
          ? buildResumeDocVariant(baseDoc, prev.tailored_bullets, prev.tailored_skills, tailored_titles, prev.tailored_summary)
          : null;
        const updated = {
          ...prev,
          tailored_titles,
          cv_variant_doc,
          updatedAt: Date.now(),
        };
        saveWorkspace(updated);
        return updated;
      });
      syncWorkspaces();
    },
    [baseCVDoc, syncWorkspaces]
  );

  /**
   * Persist a freshly-parsed structured CV. The DB write is awaited and
   * throws on failure so the caller (editor) can show a clear error — there's
   * no localStorage backstop now, so a silent failure would lose the CV.
   * Updates in-memory + workspace state optimistically before the write.
   */
  const persistBaseCVDoc = useCallback(
    async (doc: ResumeDoc): Promise<void> => {
      const flat = resumeDocToFlatSections(doc);
      setBaseCV(flat);
      setBaseCVDoc(doc);
      setBaseCVError(null);
      updateAndPersist({ cv_snapshot: flat, cv_resume_doc: doc });

      // Source-of-truth write — awaited so failures surface.
      await createCvVersion({
        application_id: null,
        sections: doc as never,
        label: "base-structured",
      });
      fireAndForget(
        "event base_cv_updated",
        appendEvent({
          kind: "base_cv_updated",
          payload: { structured: true, trigger: "auto_persist_on_upload" },
        })
      );
    },
    [updateAndPersist]
  );

  const updateBaseCV = useCallback(
    async (payload: CvSavePayload): Promise<void> => {
      // Always keep a flat snapshot for the tailor flow (which operates on
      // CVSection[]). The structured doc is the extra rail — present on a
      // clean upload, null when the user edited bullets manually.
      const flat =
        payload.kind === "doc" ? payload.flat : payload.sections;
      const doc = payload.kind === "doc" ? payload.doc : null;

      setBaseCV(flat);
      // Keep the structured doc on a flat save — nulling it would push every
      // later tailored export down the flat path.
      if (doc) setBaseCVDoc(doc);
      setBaseCVError(null);
      updateAndPersist(
        doc ? { cv_snapshot: flat, cv_resume_doc: doc } : { cv_snapshot: flat }
      );

      // Source-of-truth write — awaited. When we have a structured doc, send
      // THAT so re-renders go through the templated LaTeX path; otherwise
      // send flat (legacy static fallback fires server-side).
      const sectionsPayload: unknown = doc ?? flat;
      await createCvVersion({
        application_id: null,
        sections: sectionsPayload as never,
        label: doc ? "base-structured" : "base",
      });
      fireAndForget(
        "event base_cv_updated",
        appendEvent({
          kind: "base_cv_updated",
          payload: {
            structured: doc !== null,
            sections: flat.length,
            total_bullets: flat.reduce((acc, s) => acc + s.bullets.length, 0),
          },
        })
      );
    },
    [updateAndPersist]
  );

  /** Save the role-specific interview-prompt notes (used as an extra hint to
   *  Claude during interview mode for this workspace's role). Persists
   *  immediately so the next interview turn reads the new value. */
  const updateInterviewPrompt = useCallback(
    (text: string) => {
      updateAndPersist({ interview_system_prompt: text });
    },
    [updateAndPersist]
  );

  /**
   * Run company research: Brave search (best-effort) + any pasted content →
   * synthesized brief. Stored on the workspace and best-effort persisted to
   * the backend against the application. Needs a company name (from the parsed
   * JD) or pasted content to work with.
   */
  const runResearch = useCallback(async () => {
    const company = workspace.requirements?.company ?? "";
    const role = workspace.requirements?.role ?? "";
    const paste = workspace.research_paste ?? "";
    if (!company.trim() && !paste.trim()) {
      setError(
        "Parse the JD first (for the company name), or paste some content to research."
      );
      return;
    }
    setIsResearching(true);
    setError(null);
    setStreamStatus("");
    try {
      const { provider, effectiveSelectedProvider } = await resolveAIParams();
      const { brief, sources } = await researchCompanyFn(
        company,
        role,
        paste,
        provider,
        effectiveSelectedProvider,
        (chunk) => setStreamStatus((prev) => prev + chunk)
      );
      const company_research: CompanyResearch = {
        brief,
        sources,
        generatedAt: Date.now(),
      };
      updateAndPersist({ company_research });

      const appId = workspace.backend_application_id;
      if (appId) {
        fireAndForget(
          "createCompanyResearch",
          createCompanyResearch(appId, { brief, sources })
        );
      }
      fireAndForget(
        "event research_generated",
        appendEvent({
          kind: "research_generated",
          application_id: appId ?? null,
          payload: {
            sources: sources.length,
            talking_points: brief.talking_points.length,
            used_paste: paste.trim().length > 0,
          },
        })
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to research company");
    } finally {
      setIsResearching(false);
      setStreamStatus("");
    }
  }, [
    workspace.requirements,
    workspace.research_paste,
    workspace.backend_application_id,
    resolveAIParams,
    updateAndPersist,
  ]);

  /** Edit the generated brief in place (e.g. tweak why_them / talking_points). */
  const updateCompanyBrief = useCallback(
    (brief: CompanyBrief) => {
      setWorkspace((prev) => {
        if (!prev.company_research) return prev;
        const updated = {
          ...prev,
          company_research: { ...prev.company_research, brief },
          updatedAt: Date.now(),
        };
        saveWorkspace(updated);
        return updated;
      });
      syncWorkspaces();
    },
    [syncWorkspaces]
  );

  /** Persist the research paste box (commit on blur from the panel). */
  const setResearchPaste = useCallback(
    (text: string) => {
      updateAndPersist({ research_paste: text });
    },
    [updateAndPersist]
  );

  /**
   * Generate the cover letter: AIDA body grounded in the research brief +
   * proof from the tailored CV (falls back to the base CV). Assembles the full
   * CoverLetterDoc (candidate header, date, greeting, sign-off) and stores it.
   */
  const generateCoverLetter = useCallback(async () => {
    if (!workspace.requirements) {
      setError("Parse the JD first.");
      return;
    }
    const baseDoc = baseCVDoc ?? workspace.cv_resume_doc ?? null;
    const proofDoc = workspace.cv_variant_doc ?? baseDoc;
    if (!proofDoc) {
      setError("Add your CV (tab 3) so the letter can use real proof.");
      return;
    }
    setIsGeneratingCoverLetter(true);
    setError(null);
    setStreamStatus("");
    try {
      const { provider, effectiveSelectedProvider } = await resolveAIParams();
      const paragraphs = await generateCoverLetterFn(
        workspace.requirements,
        workspace.company_research?.brief ?? null,
        buildCandidateProof(proofDoc),
        provider,
        effectiveSelectedProvider,
        (chunk) => setStreamStatus((prev) => prev + chunk)
      );
      if (paragraphs.length === 0) {
        throw new Error("The model returned an empty letter — try again.");
      }
      const today = new Date().toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
      const doc: CoverLetterDoc = {
        candidate_name: proofDoc.header.name || baseDoc?.header.name || "",
        candidate_contact: buildCandidateContact(proofDoc),
        date: today,
        recipient: "Hiring Manager",
        company: workspace.requirements.company || null,
        role: workspace.requirements.role || null,
        greeting: "Dear Hiring Manager,",
        paragraphs,
        signoff: "Sincerely,",
      };
      const cover_letter: CoverLetter = {
        doc,
        sources: workspace.company_research?.sources ?? [],
        generatedAt: Date.now(),
      };
      updateAndPersist({ cover_letter });

      fireAndForget(
        "event cover_letter_generated",
        appendEvent({
          kind: "cover_letter_generated",
          application_id: workspace.backend_application_id ?? null,
          payload: {
            paragraphs: paragraphs.length,
            used_research: !!workspace.company_research,
          },
        })
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to generate cover letter");
    } finally {
      setIsGeneratingCoverLetter(false);
      setStreamStatus("");
    }
  }, [
    workspace.requirements,
    workspace.company_research,
    workspace.cv_variant_doc,
    workspace.cv_resume_doc,
    workspace.backend_application_id,
    baseCVDoc,
    resolveAIParams,
    updateAndPersist,
  ]);

  /** Edit the cover letter in place (body paragraphs, greeting, etc.). */
  const updateCoverLetterDoc = useCallback(
    (doc: CoverLetterDoc) => {
      setWorkspace((prev) => {
        if (!prev.cover_letter) return prev;
        const updated = {
          ...prev,
          cover_letter: { ...prev.cover_letter, doc },
          updatedAt: Date.now(),
        };
        saveWorkspace(updated);
        return updated;
      });
      syncWorkspaces();
    },
    [syncWorkspaces]
  );

  // ===========================================================================
  // M3 — follow-ups
  // ===========================================================================

  const generateFollowUps = useCallback(async () => {
    if (!workspace.requirements) {
      setError("Parse the JD first.");
      return;
    }
    setIsPlanningFollowups(true);
    setError(null);
    setStreamStatus("");
    try {
      const { provider, effectiveSelectedProvider } = await resolveAIParams();
      const raw = await generateFollowUpsFn(
        workspace.requirements,
        workspace.company_research?.brief ?? null,
        provider,
        effectiveSelectedProvider,
        (chunk) => setStreamStatus((prev) => prev + chunk)
      );
      if (raw.length === 0) {
        throw new Error("No follow-ups were generated — try again.");
      }
      const followups: FollowUpPlan = {
        followups: raw.map((f) => ({
          ...f,
          id: `fu_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
          status: "pending" as const,
        })),
        generatedAt: Date.now(),
      };
      updateAndPersist({ followups });
      fireAndForget(
        "event followups_generated",
        appendEvent({
          kind: "followups_generated",
          application_id: workspace.backend_application_id ?? null,
          payload: { count: followups.followups.length },
        })
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to plan follow-ups");
    } finally {
      setIsPlanningFollowups(false);
      setStreamStatus("");
    }
  }, [
    workspace.requirements,
    workspace.company_research,
    workspace.backend_application_id,
    resolveAIParams,
    updateAndPersist,
  ]);

  const mapFollowUps = useCallback(
    (id: string, fn: (f: FollowUp) => FollowUp) => {
      setWorkspace((prev) => {
        if (!prev.followups) return prev;
        const updated = {
          ...prev,
          followups: {
            ...prev.followups,
            followups: prev.followups.followups.map((f) =>
              f.id === id ? fn(f) : f
            ),
          },
          updatedAt: Date.now(),
        };
        saveWorkspace(updated);
        return updated;
      });
      syncWorkspaces();
    },
    [syncWorkspaces]
  );

  const toggleFollowUp = useCallback(
    (id: string) =>
      mapFollowUps(id, (f) => ({
        ...f,
        status: f.status === "done" ? "pending" : "done",
      })),
    [mapFollowUps]
  );

  const updateFollowUpDraft = useCallback(
    (id: string, draft: string) => mapFollowUps(id, (f) => ({ ...f, draft })),
    [mapFollowUps]
  );

  // ===========================================================================
  // M4 — pipeline status + one-click Application Kit
  // ===========================================================================

  const setPipelineStatus = useCallback(
    (stage: ApplicationStage) => {
      updateAndPersist({ pipeline_status: stage });
      const appId = workspace.backend_application_id;
      if (appId) {
        fireAndForget(
          "patchApplication status",
          import("@/lib/backend").then(({ patchApplication }) =>
            patchApplication(appId, {
              status: stage,
              submitted_at: stage === "submitted" ? new Date().toISOString() : null,
            })
          )
        );
      }
    },
    [updateAndPersist, workspace.backend_application_id]
  );

  /**
   * One-click kit: research (if needed) → cover letter → follow-ups, in one go.
   * Threads each step's result forward instead of relying on React state
   * settling between calls, then persists everything once. Bullet tailoring
   * stays a separate interactive step (accept/reject), so the kit uses whatever
   * CV proof already exists (tailored variant if present, else base).
   */
  const generateApplicationKit = useCallback(async () => {
    if (!workspace.requirements) {
      setError("Parse the JD first.");
      return;
    }
    const baseDoc = baseCVDoc ?? workspace.cv_resume_doc ?? null;
    const proofDoc = workspace.cv_variant_doc ?? baseDoc;
    setIsBuildingKit(true);
    setError(null);
    setStreamStatus("");
    try {
      const { provider, effectiveSelectedProvider } = await resolveAIParams();
      const stream = (chunk: string) => setStreamStatus((prev) => prev + chunk);
      const req = workspace.requirements;

      // 1. Research (skip if already present and no new paste justification).
      let company_research = workspace.company_research ?? null;
      const company = req.company ?? "";
      const paste = workspace.research_paste ?? "";
      if (!company_research && (company.trim() || paste.trim())) {
        const { brief, sources } = await researchCompanyFn(
          company,
          req.role ?? "",
          paste,
          provider,
          effectiveSelectedProvider,
          stream
        );
        company_research = { brief, sources, generatedAt: Date.now() };
      }

      // 2. Cover letter (grounded in research + existing CV proof).
      let cover_letter = workspace.cover_letter ?? null;
      if (proofDoc) {
        const paragraphs = await generateCoverLetterFn(
          req,
          company_research?.brief ?? null,
          buildCandidateProof(proofDoc),
          provider,
          effectiveSelectedProvider,
          stream
        );
        if (paragraphs.length > 0) {
          const today = new Date().toLocaleDateString(undefined, {
            year: "numeric",
            month: "long",
            day: "numeric",
          });
          const doc: CoverLetterDoc = {
            candidate_name: proofDoc.header.name || baseDoc?.header.name || "",
            candidate_contact: buildCandidateContact(proofDoc),
            date: today,
            recipient: "Hiring Manager",
            company: req.company || null,
            role: req.role || null,
            greeting: "Dear Hiring Manager,",
            paragraphs,
            signoff: "Sincerely,",
          };
          cover_letter = {
            doc,
            sources: company_research?.sources ?? [],
            generatedAt: Date.now(),
          };
        }
      }

      // 3. Follow-ups.
      const rawFollowups = await generateFollowUpsFn(
        req,
        company_research?.brief ?? null,
        provider,
        effectiveSelectedProvider,
        stream
      );
      const followups: FollowUpPlan | null =
        rawFollowups.length > 0
          ? {
              followups: rawFollowups.map((f) => ({
                ...f,
                id: `fu_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
                status: "pending" as const,
              })),
              generatedAt: Date.now(),
            }
          : workspace.followups ?? null;

      updateAndPersist({ company_research, cover_letter, followups });
      fireAndForget(
        "event application_kit_generated",
        appendEvent({
          kind: "application_kit_generated",
          application_id: workspace.backend_application_id ?? null,
          payload: {
            research: !!company_research,
            cover_letter: !!cover_letter,
            followups: followups?.followups.length ?? 0,
          },
        })
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to build application kit");
    } finally {
      setIsBuildingKit(false);
      setStreamStatus("");
    }
  }, [
    workspace.requirements,
    workspace.company_research,
    workspace.research_paste,
    workspace.cv_variant_doc,
    workspace.cv_resume_doc,
    workspace.cover_letter,
    workspace.followups,
    workspace.backend_application_id,
    baseCVDoc,
    resolveAIParams,
    updateAndPersist,
  ]);

  const newWorkspace = useCallback(() => {
    setWorkspace(freshWorkspace());
    setJDText("");
    setError(null);
    setStreamStatus("");
  }, []);

  const loadWorkspace = useCallback((id: string) => {
    const found = loadWorkspaces().find((w) => w.id === id);
    if (found) {
      // Migrate workspaces saved before Phase 2
      const migrated: JobWorkspace = {
        ...found,
        tailored_bullets: found.tailored_bullets ?? [],
        cv_variant: found.cv_variant ?? [],
      };
      setWorkspace(migrated);
      setJDText(migrated.jd_raw);
      setError(null);
    }
  }, []);

  const deleteWorkspace = useCallback(
    (id: string) => {
      deleteWsFn(id);
      syncWorkspaces();
      if (workspace.id === id) newWorkspace();
    },
    [workspace.id, newWorkspace, syncWorkspaces]
  );

  return {
    jdText,
    setJDText,
    workspace,
    baseCV,
    baseCVDoc,
    baseCVLoading,
    baseCVError,
    reloadBaseCV: loadBaseCvFromDb,
    allWorkspaces,
    isParsingJD,
    isAnalyzingGaps,
    isTailoring,
    isResearching,
    isGeneratingCoverLetter,
    isPlanningFollowups,
    isBuildingKit,
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
    runResearch,
    updateCompanyBrief,
    setResearchPaste,
    generateCoverLetter,
    updateCoverLetterDoc,
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
  };
};
