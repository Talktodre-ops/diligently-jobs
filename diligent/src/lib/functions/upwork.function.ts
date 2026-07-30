// Upwork proposal mode (Track 20).
//
// Two AI flows, mirroring the Job-mode pattern (one dedicated prompt each,
// streamed via fetchAIResponse):
//   1. findRelatedProjects — Upwork posts have no company, so instead of
//      company research we use the same Tavily `web_search` command to surface
//      real, clonable open-source repos in the job's domain. They become proof
//      / plan material the proposal can lean on.
//   2. generateProposal — an AIDA proposal whose decisive first line is a
//      first-class artifact: 3 hyper-specific opener variants + a body that
//      never fabricates experience.
//
// Upwork generation is force-routed to DeepSeek, same as the job flow (see
// DEEPSEEK_PROVIDER in ai-providers.constants.ts). Callers still pass
// provider/selectedProvider for backward compat but they're ignored.

import { fetchAIResponse } from "./ai-response.function";
import { webSearch } from "./research.function";
import { DEEPSEEK_PROVIDER, DEEPSEEK_SELECTED } from "@/config/ai-providers.constants";
import type {
  JobRequirements,
  ProposalLength,
  RelatedProject,
  ResearchSource,
  ScreeningQA,
  SolutionBrief,
  SolutionChallenge,
  TYPE_PROVIDER,
  WebSearchResult,
} from "@/types";

// =============================================================================
// JSON helpers — local copies (same pattern as job/research.function.ts)
// =============================================================================

function stripThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function stripFences(text: string): string {
  return text
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

/** Extract the first JSON object or array from a model response. */
function extractJson(text: string, kind: "object" | "array"): string {
  const cleaned = stripThinkBlocks(text);
  const codeBlock = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = codeBlock ? codeBlock[1].trim() : cleaned;
  const open = kind === "object" ? "{" : "[";
  const close = kind === "object" ? "}" : "]";
  const start = body.indexOf(open);
  const end = body.lastIndexOf(close);
  if (start === -1 || end === -1 || end < start) return body;
  return body.slice(start, end + 1);
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === "string" ? x.trim() : String(x ?? "").trim()))
    .filter(Boolean);
}

function asStr(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

// =============================================================================
// 1. Related open-source projects to clone
// =============================================================================

const PROJECTS_SYNTHESIS_SYSTEM_PROMPT = `You help a freelancer prepare to bid on an Upwork job by finding REAL, clonable open-source projects related to the job's domain and skills. They do NOT have to match the job exactly — "related" is enough (same stack, a similar feature, or a starter/example the freelancer can study, adapt, or showcase).

From the search results provided, select up to 6 genuinely relevant open-source projects. Strongly prefer GitHub repositories that contain real, clonable code.

For each project output:
- "name": the repository / project name
- "url": the canonical URL — copy it EXACTLY from the search results, never invent one. Prefer the GitHub repo page.
- "description": one line on what it is
- "why_relevant": one sentence on how cloning, studying, or adapting it helps deliver THIS job or demonstrate capability
- "language": primary language if evident from the results, else null
- "clone": a "git clone <repo>.git" command when it is clearly a GitHub/GitLab repo, else null

Hard rules:
- Use ONLY URLs that actually appear in the provided search results. NEVER fabricate repositories, owners, stars, or links.
- Skip results that are blog posts, docs, or marketing pages with no clonable code.
- If nothing clonable is present, return an empty array [].

Output ONLY valid JSON (no markdown, no code fences, no commentary):
[
  { "name": "owner/repo", "url": "https://github.com/owner/repo", "description": "...", "why_relevant": "...", "language": "TypeScript", "clone": "git clone https://github.com/owner/repo.git" }
]`;

/** Derive a `git clone …` command from a GitHub/GitLab repo URL, else null. */
function deriveClone(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)github\.com$|(^|\.)gitlab\.com$/.test(u.hostname)) return null;
    // Want exactly /owner/repo (a repo root), not deeper paths like /owner/repo/issues.
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length !== 2) return null;
    const repo = parts[1].replace(/\.git$/, "");
    return `git clone https://${u.hostname}/${parts[0]}/${repo}.git`;
  } catch {
    return null;
  }
}

function normalizeProjects(parsed: unknown): RelatedProject[] {
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const out: RelatedProject[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const name = asStr(r.name);
    const url = asStr(r.url);
    if (!name || !url) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({
      name,
      url,
      description: asStr(r.description) ?? "",
      why_relevant: asStr(r.why_relevant) ?? "",
      language: asStr(r.language),
      clone: asStr(r.clone) ?? deriveClone(url),
    });
  }
  return out;
}

/**
 * Find related open-source projects the freelancer can clone for an Upwork gig.
 * Best-effort web search (Tavily, 2 queries to conserve credits) + AI synthesis.
 * Throws only when there's nothing to search on (no role/skills/keywords/angle).
 */
export async function findRelatedProjects(
  requirements: JobRequirements,
  angle: string,
  provider: TYPE_PROVIDER | undefined,
  selectedProvider: { provider: string; variables: Record<string, string> },
  streamCallback: (chunk: string) => void
): Promise<{ projects: RelatedProject[]; sources: ResearchSource[] }> {
  const role = (requirements.role || "").trim();
  const skills = requirements.required.length
    ? requirements.required
    : requirements.keywords;
  const topSkills = skills.slice(0, 4);
  const angleTrim = angle.trim();

  const seed = [role, ...topSkills, angleTrim].filter(Boolean).join(" ").trim();
  if (!seed) {
    throw new Error(
      "Parse the job post first (or add an angle) so we know what to search for."
    );
  }

  // Two angled queries (~1 Tavily credit each): a domain/stack pass + an
  // explicit "starter / example repo" pass.
  const queries: string[] = [
    `${[role, ...topSkills].filter(Boolean).join(" ")} open source github project`.trim(),
    `${[...topSkills].filter(Boolean).join(" ") || seed} github example starter repository`.trim(),
  ];

  let results: WebSearchResult[] = [];
  for (const q of queries) {
    try {
      const r = await webSearch(q, 6, "general");
      results.push(...r);
    } catch (err) {
      console.warn("[upwork] web_search failed for query:", q, err);
    }
  }
  const seen = new Set<string>();
  results = results.filter((r) =>
    seen.has(r.url) ? false : (seen.add(r.url), true)
  );

  const webBlock = results.length
    ? results
        .slice(0, 14)
        .map(
          (r, i) =>
            `[${i + 1}] ${r.title}\n${r.url}\n${r.description}`
        )
        .join("\n\n")
    : "(no web results)";

  const userMessage = [
    `UPWORK JOB DOMAIN: ${role || "(untitled)"}`,
    topSkills.length ? `KEY SKILLS / TECH: ${topSkills.join(", ")}` : "",
    angleTrim ? `FREELANCER'S ANGLE: ${angleTrim}` : "",
    "",
    "SEARCH RESULTS:",
    webBlock,
  ]
    .filter(Boolean)
    .join("\n");

  let accumulated = "";
  void provider;
  void selectedProvider;
  for await (const chunk of fetchAIResponse({
    provider: DEEPSEEK_PROVIDER,
    selectedProvider: DEEPSEEK_SELECTED,
    systemPrompt: PROJECTS_SYNTHESIS_SYSTEM_PROMPT,
    userMessage,
  })) {
    accumulated += chunk;
    streamCallback(chunk);
  }

  let parsed: unknown = [];
  try {
    parsed = JSON.parse(extractJson(accumulated, "array"));
  } catch {
    parsed = [];
  }
  const projects = normalizeProjects(parsed);

  const sources: ResearchSource[] = results
    .slice(0, 12)
    .map((r) => ({ title: r.title, url: r.url }));

  return { projects, sources };
}

// =============================================================================
// 2. Solution brief — challenge → approach → proof (domain-specific)
// =============================================================================

const SOLUTION_BRIEF_SYSTEM_PROMPT = `You are a senior solutions architect reading a freelance job post. Produce a tight, DOMAIN-SPECIFIC brief that proves you understand THIS project and could lead it — the kind of thinking that wins technical gigs. Be concrete to the post; never generic.

Produce:
1. "challenges": the 4–7 HARD technical problems THIS specific project poses (not generic ones), each with a crisp, credible high-level "solution". Use the post's own domain terms.
2. "approach": the high-level approach as an ordered pipeline of 4–8 short steps (input → … → output), reflecting how a strong engineer would actually build Phase One.
3. "proof_strategy": 3–6 concrete, HONEST ways the freelancer can demonstrate capability — e.g. a short demo video, a minimal proof-of-concept/repo that does the core thing end-to-end, a sample structured-output JSON, or adjacent work framed honestly with a plan to close any gap. Do NOT suggest fabricating experience.
4. "json_sample": when the job involves structured/JSON output, a SHORT realistic example of the JSON the system would return (as a string). Otherwise null.

Output ONLY valid JSON (no markdown, no code fences, no commentary):
{
  "challenges": [ { "challenge": "...", "solution": "..." } ],
  "approach": ["step 1", "step 2"],
  "proof_strategy": ["..."],
  "json_sample": "..."
}`;

function normalizeChallenges(v: unknown): SolutionChallenge[] {
  if (!Array.isArray(v)) return [];
  const out: SolutionChallenge[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const challenge = asStr(r.challenge);
    const solution = asStr(r.solution);
    if (!challenge) continue;
    out.push({ challenge, solution: solution ?? "" });
  }
  return out;
}

/**
 * Derive a domain-specific challenge → approach → proof brief from the job post.
 * Grounded only in the posting (no candidate data needed) — it's about the
 * PROBLEM and how to solve/prove it. This is the spine of a proposal that lands
 * for technical gigs.
 */
export async function generateSolutionBrief(
  requirements: JobRequirements,
  jdText: string,
  provider: TYPE_PROVIDER | undefined,
  selectedProvider: { provider: string; variables: Record<string, string> },
  streamCallback: (chunk: string) => void
): Promise<SolutionBrief> {
  const userMessage = [
    `ROLE / TITLE: ${requirements.role || "(untitled gig)"}`,
    requirements.required.length
      ? `REQUIRED: ${requirements.required.join(", ")}`
      : "",
    "",
    "FULL JOB POSTING:",
    jdText.trim() || "(none provided)",
  ]
    .filter(Boolean)
    .join("\n");

  let accumulated = "";
  void provider;
  void selectedProvider;
  for await (const chunk of fetchAIResponse({
    provider: DEEPSEEK_PROVIDER,
    selectedProvider: DEEPSEEK_SELECTED,
    systemPrompt: SOLUTION_BRIEF_SYSTEM_PROMPT,
    userMessage,
  })) {
    accumulated += chunk;
    streamCallback(chunk);
  }

  let parsed: {
    challenges?: unknown;
    approach?: unknown;
    proof_strategy?: unknown;
    json_sample?: unknown;
  } = {};
  try {
    parsed = JSON.parse(extractJson(accumulated, "object"));
  } catch {
    parsed = {};
  }

  return {
    challenges: normalizeChallenges(parsed.challenges),
    approach: asStringArray(parsed.approach),
    proof_strategy: asStringArray(parsed.proof_strategy),
    json_sample: asStr(parsed.json_sample),
    generatedAt: Date.now(),
  };
}

// =============================================================================
// 3. Proposal generation (AIDA, opener-first, approach-driven)
// =============================================================================

const PROPOSAL_SYSTEM_PROMPT = `You write Upwork proposals that win technical jobs. A proposal is read in a crowded feed against dozens of competitors; the FIRST LINE decides whether the client keeps reading, and clients on serious technical jobs filter hard for someone who clearly understands their problem and can architect a solution — generic pitches get skipped instantly.

Produce TWO things:

1. "openers": THREE distinct opening lines (1–2 sentences each). Each must be HYPER-SPECIFIC to THIS posting — reference a concrete detail, deliverable, constraint, or failure mode from the job so the client instantly feels understood. Vary the angle (one leads with the outcome they want, one with a sharp question about their hardest problem, one with a precise technical insight). NEVER use generic openers like "I am writing to apply", "I came across your job post", "I am the perfect fit", "I have X years of experience", "Dear Sir/Madam", or "I hope this message finds you well".

2. "body": the rest of the proposal (do NOT repeat or restate the opener). Structure it to PROVE understanding and capability, in this order:
   - UNDERSTANDING: name the 2–3 HARDEST, most specific challenges this project poses, in the client's own domain terms (use the SOLUTION BRIEF if one is provided; otherwise infer them from the posting). This is what separates you from generic bidders.
   - APPROACH: a crisp, high-level plan/pipeline for how you'd solve it — a few concrete steps, not a wall of text. Show you can architect THEIR system; name the key tools/components where relevant.
   - PROOF: back it up. If candidate proof is provided and relevant, lead with it. Offer a concrete, low-friction PROOF-OF-CONCEPT or demo to de-risk the hire (e.g. "I can send a short demo: one of your plan pages in → structured JSON + an overlay out"), and reference relevant open-source projects you'd adapt. State genuinely transferable strengths confidently.
   - ANSWER THEIR ASKS: if the posting asks specific questions (individual vs team, who owns the work, prior examples), answer them directly and briefly.
   - ACTION: a short, confident close — propose a quick call, or the PoC, as the next step.

Hard rules:
- Be the expert in the room: concrete, specific, senior. Match the client's vocabulary.
- Reframe transferable skills confidently, but do NOT invent specific false history — no fabricated employers, clients, project names, or metrics, and do not describe unrelated work as the same skill the job needs (a domain expert sees through it and stops reading). When direct experience is thin, WIN on approach + a real PoC offer, not on a tenuous analogy.
- No fluff, no buzzword soup. Plain text only — no markdown headings; avoid bullet characters unless a short list genuinely helps readability.
- BANNED phrases: "I am writing to", "I am excited to apply", "perfect fit", "results-driven", "passionate", "proven track record", "I believe", "to whom it may concern", "I hope this message finds you well", "go-getter", "team player", "hit the ground running".
- BODY length: {{LENGTH_GUIDANCE}}.

Output ONLY valid JSON (no markdown, no code fences, no commentary):
{ "openers": ["...", "...", "..."], "body": "..." }`;

function lengthGuidance(length: ProposalLength): string {
  return length === "detailed"
    ? "about 220–320 words — enough to lay out a concrete approach/plan"
    : "about 120–180 words — tight and skimmable (default for Upwork)";
}

/** Compact one-line-per-project block fed to the proposal as plan material. */
function formatProjects(projects: RelatedProject[]): string {
  if (!projects.length) return "";
  return projects
    .slice(0, 5)
    .map((p) => `- ${p.name}: ${p.why_relevant || p.description}`)
    .join("\n");
}

/** Format the solution brief (challenges/approach/proof) for the prompt. */
function formatBrief(brief: SolutionBrief | null): string {
  if (!brief) return "";
  const parts: string[] = [];
  if (brief.challenges.length) {
    parts.push(
      "KEY CHALLENGES → SOLUTIONS (use these to show understanding):\n" +
        brief.challenges
          .map((c) => `- ${c.challenge}${c.solution ? ` → ${c.solution}` : ""}`)
          .join("\n")
    );
  }
  if (brief.approach.length) {
    parts.push(
      "HIGH-LEVEL APPROACH:\n" +
        brief.approach.map((s, i) => `${i + 1}. ${s}`).join("\n")
    );
  }
  if (brief.proof_strategy.length) {
    parts.push("PROOF STRATEGY:\n- " + brief.proof_strategy.join("\n- "));
  }
  return parts.join("\n\n");
}

/**
 * Generate an Upwork proposal: 3 hyper-specific opener variants + a body
 * (opener excluded) structured as understanding → approach → proof → action.
 * Driven by the solution brief (domain-specific challenges/approach) plus the
 * candidate's real proof + projects + angle. Never fabricates experience.
 */
export async function generateProposal(
  requirements: JobRequirements,
  jdText: string,
  candidateProof: string,
  projects: RelatedProject[],
  brief: SolutionBrief | null,
  angle: string,
  length: ProposalLength,
  provider: TYPE_PROVIDER | undefined,
  selectedProvider: { provider: string; variables: Record<string, string> },
  streamCallback: (chunk: string) => void
): Promise<{ openers: string[]; body: string }> {
  const briefBlock = formatBrief(brief);
  const userMessage = [
    `ROLE / TITLE: ${requirements.role || "(untitled gig)"}`,
    requirements.required.length
      ? `REQUIRED: ${requirements.required.join(", ")}`
      : "",
    requirements.nice_to_have.length
      ? `NICE TO HAVE: ${requirements.nice_to_have.join(", ")}`
      : "",
    requirements.keywords.length
      ? `KEYWORDS: ${requirements.keywords.join(", ")}`
      : "",
    "",
    "FULL JOB POSTING (verbatim — mine it for the specific opener hooks):",
    jdText.trim() || "(none provided)",
    "",
    briefBlock ? `SOLUTION BRIEF (your domain-specific angle on this job):\n${briefBlock}` : "",
    "",
    "CANDIDATE PROOF (use only what's here — do not invent):",
    candidateProof || "(none provided — win on the approach + a concrete PoC offer)",
    "",
    projects.length
      ? `RELATED OPEN-SOURCE PROJECTS the candidate can adapt / build a PoC from:\n${formatProjects(projects)}`
      : "",
    angle.trim() ? `\nCANDIDATE'S ANGLE / EXTRA CONTEXT:\n${angle.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const systemPrompt = PROPOSAL_SYSTEM_PROMPT.replace(
    "{{LENGTH_GUIDANCE}}",
    lengthGuidance(length)
  );

  let accumulated = "";
  void provider;
  void selectedProvider;
  for await (const chunk of fetchAIResponse({
    provider: DEEPSEEK_PROVIDER,
    selectedProvider: DEEPSEEK_SELECTED,
    systemPrompt,
    userMessage,
  })) {
    accumulated += chunk;
    streamCallback(chunk);
  }

  let openers: string[] = [];
  let body = "";
  try {
    const obj = JSON.parse(extractJson(accumulated, "object")) as {
      openers?: unknown;
      body?: unknown;
    };
    openers = asStringArray(obj.openers).slice(0, 3);
    body = asStr(obj.body) ?? "";
  } catch {
    // Model ignored the JSON contract — treat the whole thing as the body so
    // the user still gets something to edit rather than a hard failure.
    body = stripFences(stripThinkBlocks(accumulated));
  }

  body = stripFences(body).trim();
  if (!body) {
    throw new Error("The model returned an empty proposal — try again.");
  }
  return { openers, body };
}

// =============================================================================
// 3. Screening / follow-up question answers
// =============================================================================

const SCREENING_SYSTEM_PROMPT = `You answer the screening / follow-up questions an Upwork client attaches to a job, on behalf of a freelancer who is submitting a proposal. These are read right after the proposal, so they must be specific, honest, and consistent with it.

For EACH question, write a tight answer (usually 1–3 sentences) that:
- Answers the actual question directly, first sentence first. Do NOT restate the question.
- Uses the candidate's REAL proof and the related projects when relevant. NEVER fabricate experience, employers, tools, clients, or numbers.
- When the honest answer is "no" or "not directly" (e.g. they ask for domain experience the candidate lacks), say so briefly and pivot to the closest genuine strength or a concrete plan/approach — do NOT bluff or stretch an unrelated achievement into a claim a domain expert would see through.
- Stays consistent with the proposal — never contradicts it.
- Is concrete and human. No filler, no buzzwords.

Output ONLY a valid JSON array (no markdown, no code fences, no commentary), one object per question IN THE SAME ORDER as given:
[ { "question": "echo the question", "answer": "..." } ]`;

/**
 * Answer the Upwork screening/follow-up questions. Results are aligned to the
 * input `questions` by order (the displayed question stays exactly what the
 * user pasted). Grounded in the candidate's proof + projects + the proposal so
 * the answers stay consistent; never fabricates experience.
 */
export async function answerScreeningQuestions(
  questions: string[],
  requirements: JobRequirements,
  candidateProof: string,
  projects: RelatedProject[],
  brief: SolutionBrief | null,
  proposalBody: string,
  angle: string,
  provider: TYPE_PROVIDER | undefined,
  selectedProvider: { provider: string; variables: Record<string, string> },
  streamCallback: (chunk: string) => void
): Promise<ScreeningQA[]> {
  if (questions.length === 0) {
    throw new Error("Paste at least one screening question first.");
  }

  const numbered = questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
  const briefBlock = formatBrief(brief);

  const userMessage = [
    `ROLE / TITLE: ${requirements.role || "(untitled gig)"}`,
    requirements.required.length
      ? `REQUIRED: ${requirements.required.join(", ")}`
      : "",
    "",
    "SCREENING QUESTIONS (answer each, in order):",
    numbered,
    "",
    briefBlock ? `SOLUTION BRIEF (your domain angle — draw on it for approach answers):\n${briefBlock}` : "",
    "",
    "CANDIDATE PROOF (use only what's here — do not invent):",
    candidateProof || "(none provided — lean on approach + a concrete PoC offer)",
    "",
    projects.length
      ? `RELATED OPEN-SOURCE PROJECTS the candidate can adapt:\n${formatProjects(projects)}`
      : "",
    proposalBody.trim()
      ? `\nPROPOSAL ALREADY WRITTEN (stay consistent with it):\n${proposalBody.trim()}`
      : "",
    angle.trim() ? `\nCANDIDATE'S ANGLE / EXTRA CONTEXT:\n${angle.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  let accumulated = "";
  void provider;
  void selectedProvider;
  for await (const chunk of fetchAIResponse({
    provider: DEEPSEEK_PROVIDER,
    selectedProvider: DEEPSEEK_SELECTED,
    systemPrompt: SCREENING_SYSTEM_PROMPT,
    userMessage,
  })) {
    accumulated += chunk;
    streamCallback(chunk);
  }

  let parsed: unknown = [];
  try {
    parsed = JSON.parse(extractJson(accumulated, "array"));
  } catch {
    parsed = [];
  }
  const arr = Array.isArray(parsed) ? parsed : [];
  if (arr.length === 0) {
    throw new Error("Couldn't parse the answers — try again.");
  }

  // Align answers to the input questions by order; keep the user's exact
  // question text regardless of how the model echoed it.
  return questions.map((q, i) => {
    const item = arr[i] as { answer?: unknown } | undefined;
    return { question: q, answer: asStr(item?.answer) ?? "" };
  });
}

// =============================================================================
// 5. Architecture diagram (domain-specific Mermaid)
// =============================================================================

const ARCHITECTURE_DIAGRAM_SYSTEM_PROMPT = `You are a senior solutions architect. Produce a Mermaid diagram of the SOLUTION ARCHITECTURE for this specific freelance job — the kind of diagram that makes the client think "this person clearly gets it." It must be concrete to THIS project; a generic "Frontend → Backend → Database" sketch is a failure.

Requirements:
- Output a Mermaid flowchart: start with "flowchart TD" (or "flowchart LR" if the flow is long and linear).
- Use the project's REAL components, data, and flow — derived from the job post and the solution brief. Name nodes in the client's own domain terms.
- Group stages into subgraphs (the phases/layers of the system) when it clarifies the design.
- Show the key DECISION points as diamond nodes ({like this}) for the hard problems (eligibility checks, thresholds, branching), and draw the FAILURE / error / "needs review" paths explicitly — not just the happy path.
- Show any human-in-the-loop / review / approval step explicitly, including the loop back when the user edits/rejects.
- Show inputs and outputs (what comes in, what the system returns) and external services/APIs by name where relevant.
- 12–22 nodes is the target: rich enough to show real depth, not so dense it's unreadable.

Strict Mermaid syntax (so it renders):
- Node ids are short alphanumeric tokens (A, B2, scaleCalc). Human text goes inside [square brackets], {curly braces for decisions}, or ([stadium]).
- Keep label text PLAIN: letters, numbers, spaces, hyphens only. NO parentheses, slashes, colons, quotes, or special characters inside labels — they break the parser. (e.g. write [Scale calibration] not [Scale (1:100)].)
- Edge labels use the form: A -->|short label| B.
- One statement per line.

Output ONLY the Mermaid code. No markdown code fences, no prose, no explanation before or after.`;

/** Strip code fences / think blocks and a leading "mermaid" word the model may add. */
function stripToMermaid(text: string): string {
  let out = stripThinkBlocks(text);
  const fenced = out.match(/```(?:mermaid)?\s*([\s\S]*?)```/i);
  if (fenced) out = fenced[1];
  out = out.trim().replace(/^mermaid\s+/i, "");
  return out.trim();
}

/**
 * Generate a domain-specific architecture diagram (Mermaid flowchart) for the
 * proposal, grounded in the job post + the solution brief's challenges/approach.
 * Returns the Mermaid source (no fences). Throws if the model returns nothing.
 */
export async function generateArchitectureDiagram(
  requirements: JobRequirements,
  jdText: string,
  brief: SolutionBrief | null,
  provider: TYPE_PROVIDER | undefined,
  selectedProvider: { provider: string; variables: Record<string, string> },
  streamCallback: (chunk: string) => void
): Promise<string> {
  const briefBlock = formatBrief(brief);
  const userMessage = [
    `ROLE / TITLE: ${requirements.role || "(untitled gig)"}`,
    requirements.required.length
      ? `REQUIRED: ${requirements.required.join(", ")}`
      : "",
    "",
    briefBlock
      ? `SOLUTION BRIEF (base the diagram on this approach):\n${briefBlock}`
      : "",
    "",
    "FULL JOB POSTING:",
    jdText.trim() || "(none provided)",
  ]
    .filter(Boolean)
    .join("\n");

  let accumulated = "";
  void provider;
  void selectedProvider;
  for await (const chunk of fetchAIResponse({
    provider: DEEPSEEK_PROVIDER,
    selectedProvider: DEEPSEEK_SELECTED,
    systemPrompt: ARCHITECTURE_DIAGRAM_SYSTEM_PROMPT,
    userMessage,
  })) {
    accumulated += chunk;
    streamCallback(chunk);
  }

  const code = stripToMermaid(accumulated);
  if (!code || code.split("\n").length < 2) {
    throw new Error("The model returned an empty diagram — try again.");
  }
  return code;
}
