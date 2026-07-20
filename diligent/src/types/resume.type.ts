// Canonical structured CV shape. Stored opaquely inside cv_versions.sections
// (jsonb) — no SQL migration needed for shape evolution.
//
// The frontend parser (cv.function.ts) emits this, the structured editor
// (CVEditor) edits it, the tailor (useJobWorkspace) rewrites bullets in place,
// and the backend's LaTeX template (cv.tex.tera) renders it. Mirror of the
// Rust `ResumeDoc` in backend/src/render/resume.rs — keep both in sync.

export interface ResumeDoc {
  header: ResumeHeader;
  /** One-paragraph professional summary. Optional. */
  summary?: string | null;
  experience: ExperienceEntry[];
  education: EducationEntry[];
  skills: SkillGroup[];
  projects: ProjectEntry[];
}

export interface ResumeHeader {
  name: string;
  /** Tagline under the name — e.g. "AI & Machine Learning Engineer". */
  title: string;
  email?: string | null;
  linkedin?: ResumeLink | null;
  github?: ResumeLink | null;
  website?: ResumeLink | null;
  phone?: string | null;
}

/** URL + display text. `display` is what the reader sees; `url` is the
 *  hyperlink target (full https:// form). */
export interface ResumeLink {
  url: string;
  display: string;
}

export interface ExperienceEntry {
  role: string;
  company: string;
  location?: string | null;
  /** Free-form start date — the template doesn't parse, just renders. */
  start: string;
  end: string;
  bullets: string[];
}

export interface EducationEntry {
  institution: string;
  location?: string | null;
  degree: string;
  start?: string | null;
  end?: string | null;
}

export interface SkillGroup {
  /** Bold inline label — e.g. "AI/ML & NLP". */
  label: string;
  items: string[];
}

export interface ProjectEntry {
  /** Bold project name shown before the description. Optional. */
  name?: string | null;
  description: string;
  link?: ResumeLink | null;
}

/** Empty starter — useful as initial state for a brand-new CV editor. */
export const EMPTY_RESUME_DOC: ResumeDoc = {
  header: { name: "", title: "" },
  summary: null,
  experience: [],
  education: [],
  skills: [],
  projects: [],
};

/** Type guard — distinguishes a `ResumeDoc` from the legacy flat
 *  `CVSection[]` shape that older `cv_versions.sections` rows hold. */
export function isResumeDoc(value: unknown): value is ResumeDoc {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "header" in value
  );
}
