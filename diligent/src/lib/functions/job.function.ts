import type {
  CVSection,
  Gap,
  JobRequirements,
  SkillGroup,
  TailoredBullet,
  TailoredTitles,
  TYPE_PROVIDER,
} from "@/types";
import { fetchAIResponse } from "./ai-response.function";
import { extractJson, parseJsonLenient, stripThinkBlocks } from "./json-utils.function";
import { DEEPSEEK_PROVIDER, DEEPSEEK_SELECTED } from "@/config/ai-providers.constants";
import { HUMAN_VOICE_RULES } from "@/config/human-voice.constants";

// Job-application generation runs on DeepSeek (thinking disabled — see
// DEEPSEEK_PROVIDER). Callers still pass provider/selectedProvider for
// backward compat but they're ignored, so this is opaque to the hook layer.
// 8192 vs the provider template's 4096 default. Tailored CVs hit the cap
// at 4096 on real-world resumes and truncate mid-array.
const JOB_BODY_OVERRIDES: Record<string, unknown> = { max_tokens: 8192 };

const PARSE_JD_SYSTEM_PROMPT = `You extract structured job requirements from a job description.
Output ONLY valid JSON with this exact structure (no markdown, no code blocks, no explanation):
{
  "role": "job title",
  "company": "company name",
  "required": ["required skill or qualification"],
  "nice_to_have": ["nice-to-have skill"],
  "keywords": ["ATS keyword"]
}`;

const ANALYZE_GAPS_SYSTEM_PROMPT = `You are a CV gap analyzer. Compare each job requirement against the provided CV bullets.
Output ONLY a valid JSON array (no markdown, no code blocks, no explanation):
[
  { "requirement": "the requirement text", "cv_match": "closest matching CV bullet, or null if none", "status": "covered" },
  { "requirement": "another requirement", "cv_match": null, "status": "missing" }
]
Status values: "covered" (CV clearly addresses it), "partial" (CV touches it but weakly), "missing" (no relevant CV content).`;

// JSON repair helpers now live in ./json-utils.function.ts — same logic
// shared with cv.function.ts plus a jsonrepair fallback that handles
// unescaped quotes, trailing commas, and other LLM-ish breakage.

export async function parseJD(
  jdText: string,
  provider: TYPE_PROVIDER | undefined,
  selectedProvider: { provider: string; variables: Record<string, string> },
  streamCallback: (chunk: string) => void
): Promise<JobRequirements> {
  let accumulated = "";
  // provider/selectedProvider ignored — force-routed to Claude. See module top.
  void provider;
  void selectedProvider;
  for await (const chunk of fetchAIResponse({
    provider: DEEPSEEK_PROVIDER,
    selectedProvider: DEEPSEEK_SELECTED,
    systemPrompt: PARSE_JD_SYSTEM_PROMPT,
    userMessage: jdText,
    bodyOverrides: JOB_BODY_OVERRIDES,
    logLabel: "JD.parse",
  })) {
    accumulated += chunk;
    streamCallback(chunk);
  }
  const jsonStr = extractJson(accumulated);
  const parsed = parseJsonLenient<Partial<JobRequirements>>(jsonStr);
  return {
    role: parsed.role ?? "",
    company: parsed.company ?? "",
    required: Array.isArray(parsed.required) ? parsed.required : [],
    nice_to_have: Array.isArray(parsed.nice_to_have) ? parsed.nice_to_have : [],
    keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
  };
}

export async function analyzeGaps(
  requirements: JobRequirements,
  cvSections: CVSection[],
  provider: TYPE_PROVIDER | undefined,
  selectedProvider: { provider: string; variables: Record<string, string> },
  streamCallback: (chunk: string) => void
): Promise<Gap[]> {
  const cvBullets = cvSections
    .flatMap((s) => s.bullets.map((b) => `[${s.section}] ${b}`))
    .join("\n");

  const allRequirements = [
    ...requirements.required.map((r) => `REQUIRED: ${r}`),
    ...requirements.nice_to_have.map((r) => `NICE TO HAVE: ${r}`),
  ].join("\n");

  const userMessage = `JOB REQUIREMENTS:\n${allRequirements}\n\nMY CV BULLETS:\n${cvBullets}`;

  let accumulated = "";
  void provider;
  void selectedProvider;
  for await (const chunk of fetchAIResponse({
    provider: DEEPSEEK_PROVIDER,
    selectedProvider: DEEPSEEK_SELECTED,
    systemPrompt: ANALYZE_GAPS_SYSTEM_PROMPT,
    userMessage,
    bodyOverrides: JOB_BODY_OVERRIDES,
    logLabel: "Job.analyzeGaps",
  })) {
    accumulated += chunk;
    streamCallback(chunk);
  }
  const jsonStr = extractJson(accumulated);
  const parsed = parseJsonLenient<Partial<Gap>[]>(jsonStr);
  if (!Array.isArray(parsed)) return [];
  return parsed.map((g) => ({
    requirement: g.requirement ?? "",
    cv_match: g.cv_match || undefined,
    status: (["covered", "partial", "missing"].includes(g.status ?? "")
      ? g.status
      : "missing") as Gap["status"],
  }));
}

const TAILOR_BULLETS_SYSTEM_PROMPT = `You tailor a candidate's CV bullets to a SPECIFIC target role and its domain, targeting a tight one-page CV. You reposition their REAL work into the target domain and cut what doesn't belong.

DOMAIN FIT (most important):
- Infer the target DOMAIN from the job (role + required skills + keywords): e.g. fintech/payments, healthcare, e-commerce, devtools, data/ML, security.
- For EACH bullet, decide keep vs cut:
  - keep=true → the work is relevant to the target role/domain, OR can be honestly reframed to foreground it. Reframe it to LEAD with the domain-relevant capability in the domain's vocabulary — surface the dimension of the real work that matters here (e.g. a system that handled payments, invoicing and revenue → frame as financial-transaction / billing-platform work). Drop internal product names and jargon that don't carry the story.
  - keep=false → the work has no genuine relevance or transferability to this role/domain. Cut it; the candidate's other bullets carry the CV.
- ALWAYS keep=true and return verbatim any role/company/date HEADER line (it contains " — " plus dates).
- Be decisive but not reckless: MOST bullets can be honestly reframed and kept — only cut the ones that truly don't map to the target role.
- NEVER cut every bullet under a single role/company — keep at least its 1–2 strongest, honestly reframed toward the domain.

TRUTHFUL REPOSITIONING (reframing, NOT fabrication):
- Reframe the REAL work — change emphasis, framing and vocabulary, never the facts.
- Reuse the candidate's real metrics; you may attach an existing number to the domain-relevant framing of the same work.
- Do NOT invent a different employer, product, team, or a domain the work has no basis for. If a bullet can't be honestly tied to the domain, cut it (keep=false) rather than fabricate.

LENGTH (hard caps — exceeding these is a failure):
- Prefer ONE LINE per bullet (~12–18 words, ~80–110 chars).
- TWO LINES absolute maximum for bullets that genuinely need a metric AND a method (~25–30 words, ~160 chars).
- No bullet may exceed 2 lines.

METRICS:
- Lead with the outcome metric where the work plausibly produced one. Pick BELIEVABLE numbers — single- to double-digit percentages, sensible dollar/scale figures. Avoid round 50%/100% and outrageous claims unless the original implied that scale.
- One metric per bullet. It is acceptable to add a plausible metric to a bullet that had none — the candidate will defend the specifics.

LANGUAGE:
- Strong action verbs drawn from the JD ("Owned", "Led", "Architected", "Shipped", "Cut"). Weave the JD's required-skill keywords and ATS terms in naturally, not as a list.

${HUMAN_VOICE_RULES}

Output ONLY a valid JSON array (no markdown, no code blocks, no explanation). Echo "original" VERBATIM so it can be matched back:
[
  { "section": "section name", "original": "original bullet verbatim", "keep": true, "rewrite": "domain-forward rewrite" },
  { "section": "section name", "original": "irrelevant bullet verbatim", "keep": false, "rewrite": "" }
]`;

const TAILOR_SKILLS_SYSTEM_PROMPT = `You are a CV skills optimizer. Regenerate the candidate's Skills section to maximize match with the target role's keywords and ATS terms.

You may:
- Rename group labels so they fit the role (e.g. "Cloud & MLOps" → "Cloud & DevOps", "AI/ML & NLP" → "Backend & Distributed Systems") — labels MUST accurately describe the items grouped under them
- Regroup, reorder, add, and drop items
- Aggressively incorporate the role's REQUIRED skills and KEYWORDS to maximize ATS match

Hard rules:
- Every item must sit under a label that genuinely describes it (no "AI/ML" label over DevOps tools)
- Keep the candidate's clearly-real strengths; layer the role's keywords on top
- 3–6 groups, each with a short label and a comma-separated set of items
- Do NOT output prose — only skill keywords/phrases per group

Output ONLY a valid JSON array (no markdown, no code blocks, no explanation):
[
  { "label": "Group label", "items": ["skill 1", "skill 2", "skill 3"] }
]`;

/**
 * Regenerate the Skills section as coherent labeled groups tuned to the role.
 * Unlike the 1:1 bullet rewrite, this restructures labels + items so the
 * output is internally consistent (no JD keywords stuffed under a wrong label).
 */
export async function tailorSkills(
  requirements: JobRequirements,
  baseSkills: SkillGroup[],
  provider: TYPE_PROVIDER | undefined,
  selectedProvider: { provider: string; variables: Record<string, string> },
  streamCallback: (chunk: string) => void
): Promise<SkillGroup[]> {
  const skillsFormatted = baseSkills
    .map((g) => `${g.label}: ${g.items.join(", ")}`)
    .join("\n");

  const userMessage = [
    `JOB: ${requirements.role}${requirements.company ? ` at ${requirements.company}` : ""}`,
    `REQUIRED SKILLS: ${requirements.required.join(", ")}`,
    requirements.nice_to_have.length
      ? `NICE TO HAVE: ${requirements.nice_to_have.join(", ")}`
      : "",
    requirements.keywords.length ? `KEYWORDS: ${requirements.keywords.join(", ")}` : "",
    "",
    "CANDIDATE'S CURRENT SKILLS:",
    skillsFormatted,
  ]
    .filter(Boolean)
    .join("\n");

  let accumulated = "";
  void provider;
  void selectedProvider;
  for await (const chunk of fetchAIResponse({
    provider: DEEPSEEK_PROVIDER,
    selectedProvider: DEEPSEEK_SELECTED,
    systemPrompt: TAILOR_SKILLS_SYSTEM_PROMPT,
    userMessage,
    bodyOverrides: JOB_BODY_OVERRIDES,
    logLabel: "Job.tailorSkills",
  })) {
    accumulated += chunk;
    streamCallback(chunk);
  }

  const jsonStr = extractJson(accumulated);
  const parsed = parseJsonLenient<{ label?: string; items?: string[] }[]>(jsonStr);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((g) => g.label && Array.isArray(g.items))
    .map((g) => ({
      label: g.label!.trim(),
      items: g.items!.map((i) => i.trim()).filter(Boolean),
    }))
    .filter((g) => g.label && g.items.length > 0);
}

const TAILOR_TITLES_SYSTEM_PROMPT = `You reframe a candidate's professional titles to align with a target job — WITHOUT lying about what they did.

You receive the candidate's current headline tagline, their past job titles (with company), and the target role. Produce a reframed headline and a reframed title for EVERY past role.

Reframing rules (truthful "aligned reframe", NOT fabrication):
- Shift the FUNCTION wording of a past title toward the target role's domain (e.g. "AI Engineer" → "Frontend Engineer") so it reads as a plausible, equivalent description of the SAME job. The candidate's bullets for that job already describe this kind of work, so an aligned title is honest.
- PRESERVE seniority. Never add "Senior", "Lead", "Staff", "Principal", "Head", or "Manager" unless the original title already had it. Never demote either.
- Keep titles concise (2–4 words), standard industry titles.
- Do NOT invent a different employer, team, department, or scope. Only the title's function wording changes.
- If a past role genuinely cannot be honestly reframed toward the target domain, keep it equal (or very close) to the original.
- The HEADLINE is a SINGLE, clean job title — mirror the target role's level and domain (e.g. "Senior Frontend Engineer", "Backend Engineer", "Data Scientist"). It is fine for the headline to read as senior even when the per-role titles stay at their original level.
- HEADLINE MUST be just the job title — 2–4 words, ONE title only. Do NOT append programming languages, frameworks, tech stacks, specializations, or any extra clauses. NO pipes ("|"), slashes, commas, ampersands, or lists. WRONG: "Senior Software Engineer | Python, Java, TypeScript & Systems Languages | Scalable Distributed Systems". RIGHT: "Senior Software Engineer". Strip any such trailing qualifiers from the current headline when reframing.

Output ONLY valid JSON (no markdown, no code blocks, no explanation):
{
  "headline": "reframed tagline",
  "roles": [
    { "company": "company name verbatim", "original_role": "original title verbatim", "role": "reframed title" }
  ]
}`;

const TAILOR_SUMMARY_SYSTEM_PROMPT = `You rewrite a candidate's professional summary to win the 6-second recruiter skim and pass ATS for a specific role, targeting a tight one-page CV.

LENGTH (hard cap — strictly enforced):
- 4 LINES MAX on a standard CV layout. Aim for ~50 words, ~320 chars total. Going over is a failure.
- Plain prose, no bullet points. No "I"/first-person pronouns (implied subject).

Structure (adapted AIDA — NO call-to-action):
1. POSITIONING: open with a specific, senior hook that positions the candidate squarely in the TARGET DOMAIN (e.g. fintech, healthcare, devtools) — draw the domain from the JD and frame their real experience as belonging to it. Lead with the target role's level and domain, not the candidate's original domain.
2. PROOF: concrete evidence — quantified outcomes, scale, and the JD's core technologies/keywords woven in naturally.
3. FIT: close on the value the candidate brings to THIS role. Do NOT end with a call-to-action ("I'm seeking…", "let's connect", "hire me").

METRICS:
- Land 1–2 concrete numbers in the summary (latency cut, scale handled, revenue/savings driven, team led, system count).
- Pick BELIEVABLE figures — single- to double-digit percentages, sensible dollar/headcount/scale for the role's seniority. Avoid round 50%/100% and avoid outrageous claims (10×, "millions saved") unless the source material implies that scale.
- It is acceptable to add a plausible metric the source material doesn't strictly support; the candidate will defend the specifics. Keep numbers tied to plausible work shapes.

LANGUAGE:
- BANNED clichés. Never use: "results-driven", "results-oriented", "passionate", "detail-oriented", "team player", "hard-working", "go-getter", "self-starter", "proven track record", "dynamic".
- Write at SENIOR level. Mirror the target role's seniority (e.g. "Senior", "Lead", "Staff") in the positioning line. Frame the candidate as someone already operating at that level.
- Do NOT invent specific employers or a hard year-count that the source material doesn't support. You MAY position as senior/experienced without stating a number of years.
- Keep the candidate's real domain expertise. Layer the role's vocabulary on top.

${HUMAN_VOICE_RULES}

Output ONLY the rewritten summary as plain text. No JSON, no markdown, no labels, no quotes around it.`;

/**
 * Regenerate the professional summary for the target role: senior positioning,
 * Positioning→Proof→Fit structure, JD keywords woven in, clichés banned.
 * Returns plain text (not JSON). Best-effort — caller falls back to the base
 * summary on failure.
 */
export async function tailorSummary(
  requirements: JobRequirements,
  baseSummary: string,
  experience: { role: string; company: string; bullets: string[] }[],
  provider: TYPE_PROVIDER | undefined,
  selectedProvider: { provider: string; variables: Record<string, string> },
  streamCallback: (chunk: string) => void
): Promise<string> {
  // Give the model proof material: the current summary + a compact view of the
  // experience so it can ground the rewrite in real achievements.
  const expFormatted = experience
    .map((e) => `- ${e.role}${e.company ? ` @ ${e.company}` : ""}: ${(e.bullets ?? []).slice(0, 3).join(" | ")}`)
    .join("\n");

  const userMessage = [
    `TARGET ROLE: ${requirements.role}${requirements.company ? ` at ${requirements.company}` : ""}`,
    requirements.required.length ? `REQUIRED: ${requirements.required.join(", ")}` : "",
    requirements.keywords.length ? `KEYWORDS: ${requirements.keywords.join(", ")}` : "",
    "",
    `CURRENT SUMMARY:\n${baseSummary || "(none — synthesize from experience below)"}`,
    "",
    `EXPERIENCE (proof material):\n${expFormatted}`,
  ]
    .filter(Boolean)
    .join("\n");

  let accumulated = "";
  void provider;
  void selectedProvider;
  for await (const chunk of fetchAIResponse({
    provider: DEEPSEEK_PROVIDER,
    selectedProvider: DEEPSEEK_SELECTED,
    systemPrompt: TAILOR_SUMMARY_SYSTEM_PROMPT,
    userMessage,
    bodyOverrides: JOB_BODY_OVERRIDES,
    logLabel: "Job.tailorSummary",
  })) {
    accumulated += chunk;
    streamCallback(chunk);
  }

  // Plain-text output — strip any stray think blocks, code fences, or wrapping
  // quotes the model may add despite instructions.
  let out = stripThinkBlocks(accumulated)
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  if (out.length >= 2 && out.startsWith('"') && out.endsWith('"')) {
    out = out.slice(1, -1).trim();
  }
  return out || baseSummary;
}

/**
 * Reduce a headline to a single job title, cutting off any appended tech-stack
 * list. Keeps "&" intact so titles like "AI & Machine Learning Engineer" survive.
 */
export function cleanHeadline(headline: string): string {
  if (!headline) return headline;
  const head = headline
    .split(/\s*[|/•·]\s*|\s+[–—-]\s+/)[0] // pipe / slash / bullet / middot / spaced dash
    .split(/\s*,\s+/)[0] // drop a trailing comma-separated list
    .trim();
  return head || headline.trim();
}

/**
 * Reframe the headline tagline and each past job title toward the target role.
 * Truthful "aligned reframe": shifts the function wording (e.g. "AI Engineer"
 * → "Frontend Engineer") while preserving seniority and the underlying job, so
 * the rendered CV reads consistently top-to-bottom and matches ATS keywords.
 * Best-effort — a failure here leaves the original titles untouched.
 */
export async function tailorTitles(
  requirements: JobRequirements,
  baseHeadline: string,
  experience: { company: string; role: string }[],
  provider: TYPE_PROVIDER | undefined,
  selectedProvider: { provider: string; variables: Record<string, string> },
  streamCallback: (chunk: string) => void
): Promise<TailoredTitles> {
  const rolesFormatted = experience
    .map((e) => `- ${e.role}${e.company ? ` @ ${e.company}` : ""}`)
    .join("\n");

  const userMessage = [
    `TARGET ROLE: ${requirements.role}${requirements.company ? ` at ${requirements.company}` : ""}`,
    requirements.keywords.length ? `KEYWORDS: ${requirements.keywords.join(", ")}` : "",
    "",
    `CURRENT HEADLINE: ${baseHeadline}`,
    "",
    "PAST JOB TITLES:",
    rolesFormatted,
  ]
    .filter(Boolean)
    .join("\n");

  let accumulated = "";
  void provider;
  void selectedProvider;
  for await (const chunk of fetchAIResponse({
    provider: DEEPSEEK_PROVIDER,
    selectedProvider: DEEPSEEK_SELECTED,
    systemPrompt: TAILOR_TITLES_SYSTEM_PROMPT,
    userMessage,
    bodyOverrides: JOB_BODY_OVERRIDES,
    logLabel: "Job.tailorTitles",
  })) {
    accumulated += chunk;
    streamCallback(chunk);
  }

  const jsonStr = extractJson(accumulated);
  const parsed = parseJsonLenient<Partial<TailoredTitles>>(jsonStr);
  return {
    headline: cleanHeadline(
      typeof parsed.headline === "string" && parsed.headline.trim()
        ? parsed.headline.trim()
        : baseHeadline
    ),
    roles: Array.isArray(parsed.roles)
      ? parsed.roles
          .filter((r) => r && r.role && (r.original_role || r.company))
          .map((r) => ({
            company: (r.company ?? "").trim(),
            original_role: (r.original_role ?? "").trim(),
            role: r.role!.trim(),
          }))
      : [],
  };
}

/**
 * Tailor every CV bullet to the JD by chunking the input into batches of
 * BULLETS_PER_BATCH and making one Claude call per batch.
 *
 * Why batching (and not "just bump max_tokens"):
 * Claude Sonnet 4.6's standard output cap is around 8K tokens — fine for a
 * one-role CV, but a typical real-world CV (3-5 roles × 5-8 bullets each,
 * plus skills/education/projects) easily emits 10-15K tokens of structured
 * JSON. Hitting the cap caused mid-array truncation after ~6 bullets and
 * users would see the first job tailored while every later role vanished.
 * Per-batch calls keep each request inside the cap with budget to spare
 * and let the parser see clean JSON per call. Partial-tolerant: a parse
 * failure in one batch logs + continues; other batches still land.
 *
 * Wall-clock cost: ~3s/batch sequential. A 4-batch CV completes in ~12s
 * vs. the old single call's ~6s — acceptable given the old call dropped
 * 70% of the output. Parallelizable later if needed (Promise.all over the
 * batch list) but sequential keeps the streamCallback ordering readable.
 */
export async function generateTailoredBullets(
  requirements: JobRequirements,
  cvSections: CVSection[],
  provider: TYPE_PROVIDER | undefined,
  selectedProvider: { provider: string; variables: Record<string, string> },
  streamCallback: (chunk: string) => void
): Promise<Omit<TailoredBullet, "id" | "status">[]> {
  void provider;
  void selectedProvider;

  // 10 bullets/batch ≈ 1-1.5K tokens of JSON output per call — well under
  // any model's cap and leaves room for verbose rewrites. Pick smaller if
  // rewrites get long enough to truncate even a 10-bullet batch.
  const BULLETS_PER_BATCH = 10;

  const headerLines = [
    `JOB: ${requirements.role}${requirements.company ? ` at ${requirements.company}` : ""}`,
    `REQUIRED SKILLS: ${requirements.required.join(", ")}`,
    requirements.keywords.length
      ? `KEYWORDS: ${requirements.keywords.join(", ")}`
      : "",
  ].filter(Boolean);

  // Build the flat list of (section, bullet) pairs preserving source order
  // so the UI displays results in the same order as the input CV.
  type BulletRef = { section: string; bullet: string };
  const allBullets: BulletRef[] = cvSections.flatMap((s) =>
    s.bullets.map((b) => ({ section: s.section, bullet: b }))
  );

  if (allBullets.length === 0) return [];

  const allResults: Omit<TailoredBullet, "id" | "status">[] = [];

  for (let i = 0; i < allBullets.length; i += BULLETS_PER_BATCH) {
    const batch = allBullets.slice(i, i + BULLETS_PER_BATCH);
    // Group this batch's bullets by section for the prompt so the model
    // sees the same section/bullet layout as before.
    const bySection = new Map<string, string[]>();
    for (const { section, bullet } of batch) {
      if (!bySection.has(section)) bySection.set(section, []);
      bySection.get(section)!.push(bullet);
    }
    const cvFormatted = [...bySection.entries()]
      .map(
        ([section, bullets]) =>
          `[${section}]\n${bullets.map((b) => `- ${b}`).join("\n")}`
      )
      .join("\n\n");

    const userMessage = [
      ...headerLines,
      "",
      "CV BULLETS (tailor every one; preserve the section name on each output entry):",
      cvFormatted,
    ].join("\n");

    const batchEnd = Math.min(i + BULLETS_PER_BATCH, allBullets.length);
    const label = `Job.tailorBullets[${i + 1}-${batchEnd}/${allBullets.length}]`;

    let accumulated = "";
    for await (const chunk of fetchAIResponse({
      provider: DEEPSEEK_PROVIDER,
      selectedProvider: DEEPSEEK_SELECTED,
      systemPrompt: TAILOR_BULLETS_SYSTEM_PROMPT,
      userMessage,
      bodyOverrides: JOB_BODY_OVERRIDES,
      logLabel: label,
    })) {
      accumulated += chunk;
      streamCallback(chunk);
    }

    try {
      const jsonStr = extractJson(accumulated);
      const parsed = parseJsonLenient<
        { section?: string; original?: string; rewrite?: string; keep?: boolean }[]
      >(jsonStr);
      if (Array.isArray(parsed)) {
        for (const b of parsed) {
          if (!b.original) continue;
          const drop = b.keep === false;
          if (!drop && !b.rewrite) continue; // a kept bullet must carry a rewrite
          allResults.push({
            section: (b.section ?? "").trim(),
            original: b.original,
            rewrite: drop ? "" : b.rewrite!,
            drop,
          });
        }
      }
    } catch (err) {
      // One batch failing shouldn't kill the run — the user keeps the
      // bullets from the other batches. parseJsonLenient already logs the
      // failing snippet via json-utils, so we just note which batch lost.
      console.warn(
        `[${label}] parse failed, continuing with partial results:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  return allResults;
}
