// Cover letter generation (Phase 3, M2).
//
// AIDA-structured letter grounded in the company research brief (Attention hook
// + Desire angle) and the tailored CV (Interest/proof). Returns the BODY
// paragraphs only — the header, date, greeting, and sign-off are assembled
// separately by the workspace so they stay consistent and editable.

import { fetchAIResponse } from "./ai-response.function";
import { AI_PROVIDERS } from "@/config/ai-providers.constants";
import { HUMAN_VOICE_RULES } from "@/config/human-voice.constants";
import type { CompanyBrief, JobRequirements, TYPE_PROVIDER } from "@/types";

// Cover letter is part of the job-applications flow — force-routed to
// Claude. Same rationale as cv.function.ts and job.function.ts: DeepSeek
// with thinking mode (our Ask-Me-Anything default) wastes 10-30s of
// latency and eats output budget on structured-text tasks. Caller still
// passes provider for backward compat — ignored.
const CLAUDE_PROVIDER = AI_PROVIDERS.find((p) => p.id === "claude")!;
const CLAUDE_SELECTED = {
  provider: "claude",
  variables: {} as Record<string, string>,
};
const COVER_LETTER_BODY_OVERRIDES: Record<string, unknown> = { max_tokens: 8192 };

const COVER_LETTER_SYSTEM_PROMPT = `You write concise, specific cover letters that read like a sharp human wrote them. Never generic or templated.

Use the AIDA structure across 3 to 4 short paragraphs:
1. ATTENTION: open with a SPECIFIC hook about THIS company. A real detail from the research (a product, recent news, a value, a technical choice). Never "I am writing to apply for…" or "I am excited about the opportunity".
2. INTEREST: connect the candidate's most relevant, concrete proof (from their CV) to the role's core requirements. Use real achievements and metrics. Do NOT invent any.
3. DESIRE: why this candidate plus this company specifically (use the "why them" angle and talking points). Show fit with the team or mission, not flattery.
4. ACTION: a brief, confident close requesting a conversation or interview.

Hard rules:
- BANNED phrases: "I am writing to", "I am excited to apply", "results-driven", "passionate", "team player", "proven track record", "perfect fit", "I believe", "to whom it may concern".
- Ground every company reference in the provided research. Do NOT fabricate facts about the company.
- Do NOT invent the candidate's experience, employers, or metrics.
- Tight and senior in tone. ~220 to 320 words total.

${HUMAN_VOICE_RULES}

Output ONLY the body paragraphs as plain text, separated by BLANK LINES. Do NOT include a header, address, date, "Dear …" greeting, or "Sincerely" sign-off. Those are added separately.`;

/**
 * Generate the cover-letter body paragraphs. Returns one string per paragraph.
 * Grounded in the research brief + the candidate's proof (tailored CV text).
 */
export async function generateCoverLetter(
  requirements: JobRequirements,
  brief: CompanyBrief | null,
  candidateProof: string,
  provider: TYPE_PROVIDER | undefined,
  selectedProvider: { provider: string; variables: Record<string, string> },
  streamCallback: (chunk: string) => void
): Promise<string[]> {
  const userMessage = [
    `TARGET ROLE: ${requirements.role}${requirements.company ? ` at ${requirements.company}` : ""}`,
    requirements.required.length ? `KEY REQUIREMENTS: ${requirements.required.join(", ")}` : "",
    requirements.keywords.length ? `KEYWORDS: ${requirements.keywords.join(", ")}` : "",
    "",
    brief?.why_them ? `WHY THEM (angle): ${brief.why_them}` : "",
    brief?.talking_points?.length
      ? `COMPANY TALKING POINTS:\n- ${brief.talking_points.join("\n- ")}`
      : "",
    brief?.recent_news?.length
      ? `RECENT COMPANY NEWS:\n- ${brief.recent_news.join("\n- ")}`
      : "",
    "",
    "CANDIDATE PROOF (use only what's here — do not invent):",
    candidateProof || "(none provided)",
  ]
    .filter(Boolean)
    .join("\n");

  let accumulated = "";
  void provider;
  void selectedProvider;
  for await (const chunk of fetchAIResponse({
    provider: CLAUDE_PROVIDER,
    selectedProvider: CLAUDE_SELECTED,
    systemPrompt: COVER_LETTER_SYSTEM_PROMPT,
    userMessage,
    bodyOverrides: COVER_LETTER_BODY_OVERRIDES,
    logLabel: "CoverLetter.generate",
  })) {
    accumulated += chunk;
    streamCallback(chunk);
  }

  // Strip stray think blocks / fences, then split into paragraphs on blank lines.
  const cleaned = accumulated
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  return cleaned
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean);
}
