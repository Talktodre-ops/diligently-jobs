// Company research (Phase 3, M1).
//
// Orchestrates: Brave web search (via the desktop `brave_search` command, which
// keeps the API key out of the bundle) + any user-pasted content (e.g. a
// LinkedIn post Brave can't fetch) → AI synthesis into a structured
// CompanyBrief. The brief's why_them / talking_points are the hooks the cover
// letter (M2) builds its AIDA "Attention/Desire" lines from.

import { invoke } from "@tauri-apps/api/core";
import { fetchAIResponse } from "./ai-response.function";
import { AI_PROVIDERS } from "@/config/ai-providers.constants";
import type {
  WebSearchResult,
  CompanyBrief,
  ResearchSource,
  TYPE_PROVIDER,
} from "@/types";
import { EMPTY_COMPANY_BRIEF } from "@/types";

// Company research is part of the job-applications flow — force-routed
// to Claude. Same rationale as cv/job/cover-letter/followup.
const CLAUDE_PROVIDER = AI_PROVIDERS.find((p) => p.id === "claude")!;
const CLAUDE_SELECTED = {
  provider: "claude",
  variables: {} as Record<string, string>,
};
const RESEARCH_BODY_OVERRIDES: Record<string, unknown> = { max_tokens: 8192 };

// =============================================================================
// Web search (desktop command — Tavily, provider-neutral on this side)
// =============================================================================

/** Query the web via the desktop Rust command. Empty array on no results.
 *  `topic` is "general" (default) or "news". */
export async function webSearch(
  query: string,
  count = 6,
  topic?: "general" | "news"
): Promise<WebSearchResult[]> {
  return invoke<WebSearchResult[]>("web_search", { query, count, topic });
}

// =============================================================================
// JSON helpers — local copy (same pattern as job/cv.function.ts)
// =============================================================================

function stripThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function extractJsonObject(text: string): string {
  const cleaned = stripThinkBlocks(text);
  const codeBlock = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = codeBlock ? codeBlock[1].trim() : cleaned;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return body;
  return body.slice(start, end + 1);
}

function parseBriefLenient(raw: string): Partial<CompanyBrief> {
  try {
    return JSON.parse(raw) as Partial<CompanyBrief>;
  } catch {
    return {};
  }
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === "string" ? x.trim() : String(x ?? "").trim()))
    .filter(Boolean);
}

// =============================================================================
// Synthesis
// =============================================================================

const RESEARCH_SYNTHESIS_SYSTEM_PROMPT = `You are a company-research analyst preparing a candidate to apply for a role. From the search snippets and any pasted content provided, synthesize a tight, FACTUAL brief.

Rules:
- Use ONLY the provided search results and pasted content. Do NOT invent facts, metrics, products, or news. If something isn't supported, leave that field empty ([] or null).
- Prefer recent, specific, dated facts (funding, launches, leadership, partnerships).
- "why_them" is a 1–2 sentence angle a strong candidate would genuinely give for wanting THIS company specifically (grounded in the facts) — concrete, not generic flattery.
- "talking_points" are 3–6 short, specific hooks the candidate can drop into a cover letter or interview (a product, a value, a recent move, a tech choice). Each must be backed by the provided material.
- Keep every item concise.

Output ONLY valid JSON (no markdown, no code fences, no commentary):
{
  "mission": "one line, or null",
  "products": ["..."],
  "tech_stack": ["..."],
  "recent_news": ["dated/specific item", "..."],
  "culture": ["value/signal", "..."],
  "why_them": "1-2 sentences, or null",
  "talking_points": ["specific hook", "..."]
}`;

function normalizeBrief(parsed: Partial<CompanyBrief>): CompanyBrief {
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() ? v.trim() : null;
  return {
    mission: str(parsed.mission),
    products: asStringArray(parsed.products),
    tech_stack: asStringArray(parsed.tech_stack),
    recent_news: asStringArray(parsed.recent_news),
    culture: asStringArray(parsed.culture),
    why_them: str(parsed.why_them),
    talking_points: asStringArray(parsed.talking_points),
  };
}

/**
 * Run the full research flow: Brave searches (best-effort) + pasted content →
 * synthesized brief + cited sources. Throws only when there's nothing to work
 * with (no company name AND no pasted content).
 */
export async function researchCompany(
  company: string,
  role: string,
  pastedContent: string,
  provider: TYPE_PROVIDER | undefined,
  selectedProvider: { provider: string; variables: Record<string, string> },
  streamCallback: (chunk: string) => void
): Promise<{ brief: CompanyBrief; sources: ResearchSource[] }> {
  const companyName = company.trim();
  const paste = pastedContent.trim();
  if (!companyName && !paste) {
    throw new Error(
      "Add a company name (parse the JD first) or paste some content to research."
    );
  }

  // 1. Gather web results — best-effort. Two angled queries to conserve Tavily
  // credits (~1 credit each): a general company overview + a recent-news pass.
  let results: WebSearchResult[] = [];
  if (companyName) {
    const queries: { q: string; topic: "general" | "news" }[] = [
      {
        q: `${companyName} company products mission culture${role ? ` ${role}` : ""}`,
        topic: "general",
      },
      { q: `${companyName} recent news announcement funding`, topic: "news" },
    ];
    for (const { q, topic } of queries) {
      try {
        const r = await webSearch(q, 6, topic);
        results.push(...r);
      } catch (err) {
        console.warn("[research] web_search failed for query:", q, err);
      }
    }
  }
  const seen = new Set<string>();
  results = results.filter((r) =>
    seen.has(r.url) ? false : (seen.add(r.url), true)
  );

  // 2. Build the synthesis input.
  const webBlock = results.length
    ? results
        .slice(0, 14)
        .map(
          (r, i) =>
            `[${i + 1}] ${r.title}${r.age ? ` (${r.age})` : ""}\n${r.url}\n${r.description}`
        )
        .join("\n\n")
    : "(no web results)";

  const userMessage = [
    `COMPANY: ${companyName || "(unknown)"}`,
    role ? `ROLE BEING APPLIED FOR: ${role}` : "",
    "",
    "SEARCH RESULTS:",
    webBlock,
    paste ? "\nPASTED CONTENT (treat as high-priority, citable):\n" + paste : "",
  ]
    .filter(Boolean)
    .join("\n");

  // 3. Synthesize.
  let accumulated = "";
  void provider;
  void selectedProvider;
  for await (const chunk of fetchAIResponse({
    provider: CLAUDE_PROVIDER,
    selectedProvider: CLAUDE_SELECTED,
    systemPrompt: RESEARCH_SYNTHESIS_SYSTEM_PROMPT,
    userMessage,
    bodyOverrides: RESEARCH_BODY_OVERRIDES,
    logLabel: "Research.synthesize",
  })) {
    accumulated += chunk;
    streamCallback(chunk);
  }

  const parsed = parseBriefLenient(extractJsonObject(accumulated));
  const brief = normalizeBrief(parsed && typeof parsed === "object" ? parsed : EMPTY_COMPANY_BRIEF);

  const sources: ResearchSource[] = results
    .slice(0, 12)
    .map((r) => ({ title: r.title, url: r.url }));

  return { brief, sources };
}
