/** Application pipeline stages (Phase 3, M4). */
export type ApplicationStage =
  | "draft"
  | "researched"
  | "tailored"
  | "letter_ready"
  | "submitted"
  | "following_up"
  | "interviewing"
  | "closed";

export interface JobRequirements {
  role: string;
  company: string;
  required: string[];
  nice_to_have: string[];
  keywords: string[];
}

export interface CVSection {
  id: string;
  section: string;
  bullets: string[];
}

export interface Gap {
  requirement: string;
  cv_match?: string;
  status: "covered" | "partial" | "missing";
}

export interface TailoredBullet {
  id: string;
  section: string;
  original: string;
  rewrite: string;
  status: "pending" | "accepted" | "rejected";
  /** Tailor judged this work irrelevant to the target role/domain. When
   *  accepted, the bullet is cut from the tailored CV rather than rewritten. */
  drop?: boolean;
}

/**
 * Reframed titles for the target role. The headline is the tagline under the
 * candidate's name; `roles` reframes each past job title. We echo back the
 * `original_role` + `company` so the variant builder can match each reframe to
 * the exact experience entry even if array order shifts.
 */
export interface TailoredTitles {
  /** Reframed headline/tagline under the candidate's name. */
  headline: string;
  roles: { company: string; original_role: string; role: string }[];
}

import type { ResumeDoc, SkillGroup } from "./resume.type";
import type { CompanyResearch } from "./research.type";
import type { CoverLetter } from "./cover-letter.type";
import type { FollowUpPlan } from "./followup.type";

export interface JobWorkspace {
  id: string;
  jd_raw: string;
  requirements?: JobRequirements;
  cv_snapshot: CVSection[];
  /**
   * Structured representation of the base CV (post-B2). Drives the templated
   * LaTeX export so the rendered PDF matches the user's original layout.
   * `cv_snapshot` (flat) is kept in parallel for the tailor flow until B4
   * teaches it to operate on this structure directly.
   *
   * Null when the user hasn't uploaded a structured CV yet, or when they
   * edited the flat bullets after upload (which invalidates the doc).
   */
  cv_resume_doc?: ResumeDoc | null;
  gaps: Gap[];
  tailored_bullets: TailoredBullet[];
  cv_variant: CVSection[];
  /**
   * Structured tailored CV — base `cv_resume_doc` with accepted bullet
   * rewrites swapped into experience[].bullets[]. Drives the templated LaTeX
   * export for tailored CVs so the rendered PDF matches the user's layout
   * with the rewritten content. Null when there's no structured base doc
   * (e.g. legacy upload) — export then falls back to the flat/static path.
   */
  cv_variant_doc?: ResumeDoc | null;
  /**
   * Regenerated Skills section for the target role — coherent labeled groups
   * (not 1:1 bullet rewrites). Editable before export. When present it
   * overrides the base doc's skills in the tailored variant.
   */
  tailored_skills?: SkillGroup[] | null;
  /**
   * Reframed headline + per-role job titles aligned to the target role. When
   * present it overrides the base doc's `header.title` and each
   * `experience[].role` in the tailored variant. Generated alongside the
   * tailored bullets; null until then (or if generation failed).
   */
  tailored_titles?: TailoredTitles | null;
  /**
   * Regenerated professional summary tuned to the target role — senior
   * positioning, Positioning→Proof→Fit structure, JD keywords woven in. When
   * present it overrides the base doc's `summary` in the tailored variant
   * (takes precedence over the generic bullet-rewrite of the summary line).
   * Null until generated, or if generation failed.
   */
  tailored_summary?: string | null;
  /**
   * Company research brief (Phase 3, M1) — Brave-sourced + AI-synthesized,
   * feeds the cover letter's hooks. Null until research is run.
   */
  company_research?: CompanyResearch | null;
  /**
   * User-pasted research material (e.g. a LinkedIn post Brave can't fetch).
   * Persisted so it survives reloads and feeds the next research run.
   */
  research_paste?: string;
  /**
   * Cover letter (Phase 3, M2) — AIDA letter grounded in the research brief +
   * tailored CV. Null until generated. Persisted to the backend on export.
   */
  cover_letter?: CoverLetter | null;
  /** Follow-up cadence + AI-drafted messages (Phase 3, M3). */
  followups?: FollowUpPlan | null;
  /**
   * Application pipeline stage (Phase 3, M4). Drives the stepper + which
   * follow-ups are relevant. Defaults to "draft".
   */
  pipeline_status?: ApplicationStage;
  createdAt: number;
  updatedAt: number;
  /**
   * UUID assigned by the backend when the workspace first syncs. Created on
   * the first successful `parseJD` after backend connectivity. Once set, all
   * subsequent events (gap analysis, bullet decisions, cv variants) reference
   * this id so the timeline view can join them.
   *
   * Stays `undefined` if the backend is offline at parse time — workspace
   * still works locally; sync gets re-attempted on the next workspace action.
   */
  backend_application_id?: string;
  /**
   * Free-form notes the user wants Claude to know during interview mode
   * for THIS specific role. Appended to the composed interview system prompt
   * after the standard role/CV context. Use it for things like:
   *   "This is a Staff Eng role focused on payment rails. The CTO is
   *    technical, expect deep system-design questions on consistency."
   *   "Emphasize my open-source contributions when relevant."
   */
  interview_system_prompt?: string;
}
