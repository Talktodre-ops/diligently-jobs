// Company research types (Phase 3, M1).
//
// A CompanyBrief is the structured synthesis the AI produces from Brave search
// results + any pasted content (e.g. a LinkedIn post Brave can't fetch). It's
// stored on the workspace and feeds the cover letter (why_them / talking_points
// are the cover-letter hooks) and interview prep.

/** One web result, as returned by the `web_search` Tauri command (Tavily).
 *  `description` carries Tavily's LLM-ready extracted content. */
export interface WebSearchResult {
  title: string;
  url: string;
  description: string;
  age?: string | null;
}

/** A cited source the brief was built from. */
export interface ResearchSource {
  title: string;
  url: string;
}

export interface CompanyBrief {
  /** One-line mission / what the company does. */
  mission: string | null;
  /** Products / services. */
  products: string[];
  /** Tech the company is known to use (esp. matching the JD). */
  tech_stack: string[];
  /** Recent, dated developments (funding, launches, leadership, etc.). */
  recent_news: string[];
  /** Culture / values signals. */
  culture: string[];
  /** The angle — why this candidate is drawn to THIS company. Cover-letter
   *  Attention/Desire material. */
  why_them: string | null;
  /** Concrete hooks to weave into the cover letter / interview. */
  talking_points: string[];
}

/** A stored research run for an application. */
export interface CompanyResearch {
  brief: CompanyBrief;
  sources: ResearchSource[];
  /** Epoch ms when generated. */
  generatedAt: number;
}

/** Empty brief — initial/fallback shape so the UI never reads undefined. */
export const EMPTY_COMPANY_BRIEF: CompanyBrief = {
  mission: null,
  products: [],
  tech_stack: [],
  recent_news: [],
  culture: [],
  why_them: null,
  talking_points: [],
};
