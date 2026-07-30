// Follow-up plan generation (Phase 3, M3).
//
// Produces a short, realistic follow-up cadence with an AI-drafted message per
// step, grounded in the role/company (and research, when available). Roles +
// channels + timing + drafts — never invents named people.

import { fetchAIResponse } from "./ai-response.function";
import { DEEPSEEK_PROVIDER, DEEPSEEK_SELECTED } from "@/config/ai-providers.constants";
import { HUMAN_VOICE_RULES } from "@/config/human-voice.constants";
import type { CompanyBrief, FollowUp, JobRequirements, TYPE_PROVIDER } from "@/types";

// Follow-up plan generation runs on DeepSeek (thinking disabled — see
// DEEPSEEK_PROVIDER). Callers still pass provider/selectedProvider for
// backward compat but they're ignored, so this is opaque to the hook layer.
const FOLLOWUP_BODY_OVERRIDES: Record<string, unknown> = { max_tokens: 8192 };

const FOLLOWUP_SYSTEM_PROMPT = `You plan a job-application follow-up cadence and draft each message.

Produce 3 to 4 steps covering the realistic arc:
1. A recruiter or talent-partner nudge a few days after applying.
2. A hiring-manager check-in about a week in.
3. A post-interview thank-you (to send after an interview).
4. (Optional) a final polite check-in if there's been silence.

For each step provide:
- "label": short name (e.g. "Recruiter nudge")
- "timing": when to send, relative to applying or interviewing (e.g. "3 days after applying")
- "channel": "LinkedIn", "Email", or "Application portal"
- "target": the ROLE to reach (e.g. "Recruiter / Talent partner", "Hiring manager"). Never a specific invented person.
- "draft": a SHORT message (2 to 4 sentences). Specific, warm-professional, references the role and company. Reuse a real research detail when relevant. No clichés ("just checking in", "circling back", "I'm a great fit"), no fabricated facts, no desperation.

${HUMAN_VOICE_RULES}

Output ONLY a valid JSON array (no markdown, no commentary):
[ { "label": "...", "timing": "...", "channel": "...", "target": "...", "draft": "..." } ]`;

function stripThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function extractJsonArray(text: string): string {
  const cleaned = stripThinkBlocks(text);
  const codeBlock = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = codeBlock ? codeBlock[1].trim() : cleaned;
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return body;
  return body.slice(start, end + 1);
}

/**
 * Generate the follow-up steps (without ids/status — the caller assigns those).
 */
export async function generateFollowUps(
  requirements: JobRequirements,
  brief: CompanyBrief | null,
  provider: TYPE_PROVIDER | undefined,
  selectedProvider: { provider: string; variables: Record<string, string> },
  streamCallback: (chunk: string) => void
): Promise<Omit<FollowUp, "id" | "status">[]> {
  const userMessage = [
    `ROLE: ${requirements.role}${requirements.company ? ` at ${requirements.company}` : ""}`,
    brief?.why_them ? `WHY THEM: ${brief.why_them}` : "",
    brief?.talking_points?.length
      ? `TALKING POINTS:\n- ${brief.talking_points.join("\n- ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  let accumulated = "";
  void provider;
  void selectedProvider;
  for await (const chunk of fetchAIResponse({
    provider: DEEPSEEK_PROVIDER,
    selectedProvider: DEEPSEEK_SELECTED,
    systemPrompt: FOLLOWUP_SYSTEM_PROMPT,
    userMessage,
    bodyOverrides: FOLLOWUP_BODY_OVERRIDES,
    logLabel: "Followup.generate",
  })) {
    accumulated += chunk;
    streamCallback(chunk);
  }

  let parsed: Array<Record<string, unknown>>;
  try {
    parsed = JSON.parse(extractJsonArray(accumulated));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const str = (v: unknown): string =>
    typeof v === "string" ? v.trim() : "";
  return parsed
    .map((s) => ({
      label: str(s.label),
      timing: str(s.timing),
      channel: str(s.channel),
      target: str(s.target),
      draft: str(s.draft),
    }))
    .filter((s) => s.label && s.draft);
}
