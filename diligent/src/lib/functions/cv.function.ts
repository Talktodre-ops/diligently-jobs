// Upload-a-resume flow: extract raw text from PDF/DOCX, then ask the LLM
// to convert it into a structured representation.
//
// Two parse paths coexist during the B2 → B4 migration:
//
//   - parseCvToResumeDoc → ResumeDoc (new, structured). Drives the templated
//     LaTeX export at backend/templates/cv.tex.tera so the rendered PDF
//     mirrors the user's original layout (role/company/dates/etc).
//
//   - parseCv → CVSection[] (legacy, flat). Still used by the tailor flow
//     (which expects flat bullets); will be retired in B4 once the tailor
//     operates directly on ResumeDoc.experience[].bullets[].

import { fetchAIResponse } from "./ai-response.function";
import { extractJson, parseJsonLenient } from "./json-utils.function";
import { DEEPSEEK_PROVIDER, DEEPSEEK_SELECTED } from "@/config/ai-providers.constants";
import type { CVSection, ResumeDoc, TYPE_PROVIDER } from "@/types";

// CV generation runs on DeepSeek (thinking disabled — see
// DEEPSEEK_PROVIDER). Callers still pass provider/selectedProvider for
// backward compat but they're ignored, so this is opaque to the hook layer.

// max_tokens override for CV ops. The provider template defaults to 4096
// which truncates full CV regenerations mid-output. 8192 fits a real CV
// comfortably (verified on ~6-page resumes during testing).
const CV_BODY_OVERRIDES: Record<string, unknown> = { max_tokens: 8192 };

// =============================================================================
// File → text
// =============================================================================

/** Throws on unsupported types. Returns plain text with section breaks. */
export async function extractCvText(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf") || file.type === "application/pdf") {
    return extractPdfText(file);
  }
  if (
    name.endsWith(".docx") ||
    file.type ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return extractDocxText(file);
  }
  throw new Error(
    `Unsupported file type: ${file.name}. Upload a .pdf or .docx (Word document).`
  );
}

async function extractPdfText(file: File): Promise<string> {
  // pdfjs needs a Web Worker for parsing. Vite resolves the `?url` suffix at
  // build time so the worker file is served from the dev server / bundled
  // alongside the app — no CDN dependency.
  const pdfjs = await import("pdfjs-dist");
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const buffer = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buffer }).promise;

  const pageTexts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    // Each item is either a TextItem (has .str) or a TextMarkedContent (no .str).
    // Join with spaces, then collapse multiple spaces. PDFs often emit text in
    // odd reading order — that's fine, the LLM is smart enough to re-section.
    const pageText = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (pageText) pageTexts.push(pageText);
  }
  return pageTexts.join("\n\n");
}

async function extractDocxText(file: File): Promise<string> {
  const mammoth = await import("mammoth");
  const buffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer: buffer });
  // mammoth preserves paragraph breaks as \n — good signal for the LLM.
  return result.value.trim();
}

// =============================================================================
// Text → CVSection[] via LLM
// =============================================================================

const PARSE_CV_SYSTEM_PROMPT = `You convert raw resume/CV text into structured sections.
Output ONLY valid JSON (no markdown, no code blocks, no explanation):
[
  { "section": "Experience", "bullets": ["bullet 1 verbatim", "bullet 2 verbatim"] },
  { "section": "Skills", "bullets": ["skill or short phrase"] }
]

Rules:
- Preserve bullets VERBATIM from the resume — do not paraphrase or summarize
- Section names should match what the resume uses (Experience, Work Experience, Skills, Education, Projects, Certifications, Publications, etc.)
- For each job role: turn the title + company + dates into one bullet, then each accomplishment under that role becomes its own bullet
- Strip line numbers, bullet symbols (•, -, *, ▪), and excess whitespace
- DROP the personal/contact info section (name, email, phone, address, LinkedIn URL) — that's metadata, not content
- Skip empty sections
- Maintain the order the sections appear in the source resume`;

// JSON repair helpers now live in ./json-utils.function.ts — same logic
// shared with job.function.ts plus a jsonrepair fallback that handles
// unescaped quotes, trailing commas, and other LLM-ish breakage.

function makeId() {
  return `cv_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
}

// =============================================================================
// Structured parser → ResumeDoc
// =============================================================================

const PARSE_RESUME_DOC_SYSTEM_PROMPT = `You convert raw resume/CV text into the following JSON structure.
Output ONLY valid JSON — no markdown, no code blocks, no explanation. Schema:

{
  "header": {
    "name": "full name as written",
    "title": "tagline under the name (e.g. 'AI & Machine Learning Engineer')",
    "email": "email@example.com OR null",
    "linkedin": { "url": "https://...", "display": "linkedin.com/in/handle" } OR null,
    "github":   { "url": "https://...", "display": "github.com/handle" } OR null,
    "website":  { "url": "https://...", "display": "example.com" } OR null,
    "phone": "+1 555 ... OR null"
  },
  "summary": "one paragraph professional summary, verbatim from resume OR null",
  "experience": [
    {
      "role": "Software Engineer",
      "company": "Example Corp",
      "location": "Remote OR city/country OR null",
      "start": "Jan. 2023",
      "end": "Present (or 'Mon. YYYY')",
      "bullets": ["bullet 1 verbatim", "bullet 2 verbatim"]
    }
  ],
  "education": [
    {
      "institution": "State University",
      "location": "City, Country OR null",
      "degree": "Bachelor of Science in Computer Science",
      "start": "2017 OR null",
      "end": "2021 OR null"
    }
  ],
  "skills": [
    { "label": "AI/ML & NLP",  "items": ["Machine Learning", "Deep Learning", ...] },
    { "label": "Programming",  "items": ["Python", "Java", ...] }
  ],
  "projects": [
    {
      "name": "Performance Optimization (or null if the entry has no bold label)",
      "description": "what was done, achievements, metrics — verbatim",
      "link": { "url": "https://...", "display": "Case Study" } OR null
    }
  ]
}

Rules:
- Preserve bullets, summary, and project descriptions VERBATIM from the resume — do NOT paraphrase, summarize, or "improve"
- Strip bullet symbols (•, -, *, ▪) and leading whitespace from each bullet
- For linkedin/github/website: emit a Link object with both url (full https://) and display (short user-readable form). If only one form is in the resume, infer the other reasonably.
- Use null (not empty string, not missing key) when a field genuinely doesn't appear
- experience entries are ordered most recent first if the resume is written that way; otherwise preserve the source order
- skills.items split on commas: each item is one skill phrase
- projects: if a line has a bold label followed by a colon, that's the name; otherwise name is null and the whole line is description
- Output one JSON object. Nothing else.`;

/**
 * Stream the LLM and parse its JSON into a `ResumeDoc`. Same model as
 * parseCv() but a richer schema — keeps role/company/dates/section labels
 * intact so the LaTeX template can render the user's CV faithfully.
 */
export async function parseCvToResumeDoc(
  text: string,
  provider: TYPE_PROVIDER | undefined,
  selectedProvider: { provider: string; variables: Record<string, string> },
  streamCallback: (chunk: string) => void
): Promise<ResumeDoc> {
  if (!text.trim()) throw new Error("CV text is empty");

  let accumulated = "";
  // provider/selectedProvider args ignored — CV ops force-route to Claude
  // for reliable structured output. See module-top comment.
  void provider;
  void selectedProvider;
  for await (const chunk of fetchAIResponse({
    provider: DEEPSEEK_PROVIDER,
    selectedProvider: DEEPSEEK_SELECTED,
    systemPrompt: PARSE_RESUME_DOC_SYSTEM_PROMPT,
    userMessage: text,
    bodyOverrides: CV_BODY_OVERRIDES,
    logLabel: "CV.parseResumeDoc",
  })) {
    accumulated += chunk;
    streamCallback(chunk);
  }

  const jsonStr = extractJson(accumulated);
  const parsed = parseJsonLenient<ResumeDoc>(jsonStr);

  // Defensive validation — the model occasionally returns partial/invalid
  // structures and we'd rather throw a clear error here than ship a broken
  // ResumeDoc that crashes the renderer.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Model output was not a JSON object");
  }
  if (!parsed.header || typeof parsed.header !== "object") {
    throw new Error("Parsed CV is missing a `header` field");
  }
  if (!parsed.header.name || !parsed.header.title) {
    throw new Error("Parsed CV header is missing name or title");
  }

  // Normalize arrays — defaulting missing keys to [] so the template's
  // `{% if collection | length > 0 %}` guards don't blow up.
  return {
    header: parsed.header,
    summary: parsed.summary ?? null,
    experience: Array.isArray(parsed.experience) ? parsed.experience : [],
    education: Array.isArray(parsed.education) ? parsed.education : [],
    skills: Array.isArray(parsed.skills) ? parsed.skills : [],
    projects: Array.isArray(parsed.projects) ? parsed.projects : [],
  };
}

/**
 * Re-structure an existing flat `CVSection[]` into a `ResumeDoc` without a
 * file upload. Serializes the flat sections back to text and runs them
 * through the same structured parser. Lower fidelity than parsing the
 * original PDF (flat data already merged role/company/dates), but lets a
 * user upgrade legacy data in one click instead of re-uploading.
 */
export async function structureFlatCv(
  sections: CVSection[],
  provider: TYPE_PROVIDER | undefined,
  selectedProvider: { provider: string; variables: Record<string, string> },
  streamCallback: (chunk: string) => void
): Promise<ResumeDoc> {
  const text = sections
    .map(
      (s) =>
        `## ${s.section}\n` + s.bullets.map((b) => `- ${b}`).join("\n")
    )
    .join("\n\n");
  return parseCvToResumeDoc(text, provider, selectedProvider, streamCallback);
}

/**
 * Derive the legacy flat `CVSection[]` view from a `ResumeDoc`. Used by the
 * existing flat-bullet editor (CVEditor) until B3 introduces the structured
 * form, and by the tailor flow (B2-era) which still operates on flat bullets.
 *
 * Lossy by definition: role/company/dates collapse into the section title.
 * Skills/projects also flatten to bullet-style lines.
 */
export function resumeDocToFlatSections(doc: ResumeDoc): CVSection[] {
  const out: CVSection[] = [];

  if (doc.summary && doc.summary.trim()) {
    out.push({
      id: `cv_summary_${Date.now()}`,
      section: "Professional Summary",
      bullets: [doc.summary.trim()],
    });
  }

  if (doc.experience.length > 0) {
    out.push({
      id: `cv_experience_${Date.now()}`,
      section: "Experience",
      // Flatten role/company/dates into a header line per role so the tailor
      // has the full context, followed by each bullet verbatim.
      bullets: doc.experience.flatMap((e) => {
        const header = [
          [e.role, e.company].filter(Boolean).join(" — "),
          [e.start, e.end].filter(Boolean).join(" – "),
          e.location ?? "",
        ]
          .filter((s) => s && s.trim())
          .join(" · ");
        return header ? [header, ...e.bullets] : e.bullets;
      }),
    });
  }

  if (doc.education.length > 0) {
    out.push({
      id: `cv_education_${Date.now()}`,
      section: "Education",
      bullets: doc.education.map((ed) =>
        [
          ed.degree,
          ed.institution,
          [ed.start, ed.end].filter(Boolean).join(" – "),
          ed.location ?? "",
        ]
          .filter((s) => s && s.trim())
          .join(" · ")
      ),
    });
  }

  if (doc.skills.length > 0) {
    out.push({
      id: `cv_skills_${Date.now()}`,
      section: "Skills",
      bullets: doc.skills.map((g) => `${g.label}: ${g.items.join(", ")}`),
    });
  }

  if (doc.projects.length > 0) {
    out.push({
      id: `cv_projects_${Date.now()}`,
      section: "Projects & Achievements",
      bullets: doc.projects.map((p) => {
        const head = p.name ? `${p.name}: ` : "";
        const link = p.link ? `: ${p.link.display}` : "";
        return `${head}${p.description}${link}`;
      }),
    });
  }

  return out;
}

// =============================================================================
// Legacy flat parser → CVSection[]
// =============================================================================

/**
 * Stream the LLM, accumulate the JSON output, then parse it into CVSection[].
 * `streamCallback` is invoked with each chunk so the UI can show progress.
 */
export async function parseCv(
  text: string,
  provider: TYPE_PROVIDER | undefined,
  selectedProvider: { provider: string; variables: Record<string, string> },
  streamCallback: (chunk: string) => void
): Promise<CVSection[]> {
  if (!text.trim()) throw new Error("CV text is empty");

  let accumulated = "";
  // provider/selectedProvider args ignored — CV ops force-route to Claude.
  void provider;
  void selectedProvider;
  for await (const chunk of fetchAIResponse({
    provider: DEEPSEEK_PROVIDER,
    selectedProvider: DEEPSEEK_SELECTED,
    systemPrompt: PARSE_CV_SYSTEM_PROMPT,
    userMessage: text,
    bodyOverrides: CV_BODY_OVERRIDES,
    logLabel: "CV.parseFlat",
  })) {
    accumulated += chunk;
    streamCallback(chunk);
  }

  const jsonStr = extractJson(accumulated);
  const parsed = parseJsonLenient<
    Array<{ section?: string; bullets?: string[] }>
  >(jsonStr);
  if (!Array.isArray(parsed)) {
    throw new Error("Model output was not a JSON array");
  }

  return parsed
    .filter((s) => s.section && Array.isArray(s.bullets))
    .map((s) => ({
      id: makeId(),
      section: s.section!.trim(),
      bullets: s
        .bullets!.map((b) => b.trim())
        .filter((b) => b.length > 0),
    }))
    .filter((s) => s.bullets.length > 0);
}
