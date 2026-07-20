// Upwork proposal mode (Track 20).
//
// Parallel to the Job workspace but tuned for Upwork: postings have no company,
// proposals are read in a crowded feed, and the decisive thing is a
// hyper-specific opening line. Instead of company research we surface related
// open-source projects the freelancer can clone/study/showcase.

import type { JobRequirements } from "./job.type";
import type { ResearchSource } from "./research.type";

/** Proposal-writing strategy. AIDA for v1; room to add PAS/BAB later. */
export type ProposalStrategy = "aida";

/** Length preset for the generated proposal body. */
export type ProposalLength = "short" | "detailed";

/**
 * A related open-source project surfaced from the web for an Upwork gig.
 * Upwork posts have no company to research, so instead we find real, clonable
 * repos in the job's domain the freelancer can study, adapt, or showcase —
 * related to the posting, not necessarily an exact match.
 */
export interface RelatedProject {
  /** Repo / project name. */
  name: string;
  /** Canonical URL (prefer the GitHub repo page). */
  url: string;
  /** One line on what it is. */
  description: string;
  /** Why cloning/studying it helps deliver THIS job or prove capability. */
  why_relevant: string;
  /** Primary language, when known. */
  language?: string | null;
  /** Ready-to-run clone command when it's a git repo (e.g. "git clone …"). */
  clone?: string | null;
}

/** A stored project-discovery run for an Upwork gig. */
export interface ProjectResearch {
  projects: RelatedProject[];
  sources: ResearchSource[];
  /** Epoch ms when generated. */
  generatedAt: number;
}

/** One hard technical challenge the job poses + its high-level solution. */
export interface SolutionChallenge {
  challenge: string;
  solution: string;
}

/**
 * The domain-specific "how I'd solve this" brief, derived purely from the job
 * post. This is what makes a proposal land for technical gigs: name the real
 * challenges, show the high-level approach, and a concrete way to prove it —
 * instead of shoehorning in unrelated experience. Feeds proposal + screening.
 */
export interface SolutionBrief {
  /** The hard problems THIS project poses, each with a crisp solution. */
  challenges: SolutionChallenge[];
  /** High-level approach as an ordered pipeline of steps. */
  approach: string[];
  /** Concrete, honest ways to showcase capability (demo, PoC, JSON sample, adjacent work). */
  proof_strategy: string[];
  /** Optional example structured-output JSON the system would return. */
  json_sample?: string | null;
  /** Epoch ms when generated. */
  generatedAt: number;
}

/**
 * A generated Upwork proposal. The opener is a first-class artifact: the model
 * returns several hyper-specific variants and the user picks one
 * (`selected_opener`). The full paste-ready text is `openers[selected_opener]`
 * followed by `body`.
 */
export interface Proposal {
  /** Opener variants (the decisive first line). Editable. */
  openers: string[];
  /** Index of the chosen opener. */
  selected_opener: number;
  /** Body (Interest → Desire → Action), opener excluded. Editable. */
  body: string;
  strategy: ProposalStrategy;
  length: ProposalLength;
  /** Epoch ms when generated. */
  generatedAt: number;
}

/** A generated architecture diagram (Mermaid source) for the proposal. */
export interface ArchitectureDoc {
  /** Mermaid flowchart source. */
  mermaid: string;
  /** Epoch ms when generated. */
  generatedAt: number;
}

/** One answered Upwork screening / follow-up question. */
export interface ScreeningQA {
  question: string;
  answer: string;
}

/** Generated answers to the screening questions Upwork asks at submit time. */
export interface ScreeningAnswers {
  items: ScreeningQA[];
  /** Epoch ms when generated. */
  generatedAt: number;
}

export interface UpworkWorkspace {
  id: string;
  /** The pasted Upwork job/work description. */
  jd_raw: string;
  /**
   * Parsed requirements (role / required / keywords). `company` is usually
   * empty on Upwork — that's expected and fine.
   */
  requirements?: JobRequirements;
  /** Optional free-text note: the user's angle / relevant context to lean on. */
  angle?: string;
  /**
   * Whether to ground the proposal/answers in the saved base CV. Default on
   * (undefined === true). Turn off to write a proposal from the job + approach
   * alone (e.g. when the CV isn't relevant to this gig).
   */
  use_cv?: boolean;
  /** Domain-specific challenge → approach → proof brief derived from the post. */
  solution_brief?: SolutionBrief | null;
  /** Related open-source projects to clone (proof + plan material). */
  projects?: ProjectResearch | null;
  /** Architecture diagram (Mermaid) to attach to the proposal. Null until generated. */
  architecture?: ArchitectureDoc | null;
  /** Generated proposal. Null until generated. */
  proposal?: Proposal | null;
  /** Raw text of the Upwork screening/follow-up questions the user pasted. */
  screening_questions_raw?: string;
  /** Generated answers to those screening questions. Null until generated. */
  screening?: ScreeningAnswers | null;
  createdAt: number;
  updatedAt: number;
  /**
   * UUID assigned by the backend when the workspace first syncs (one
   * application row per gig). Once set, the proposal + events reference it.
   * Stays undefined if the backend was offline at parse time.
   */
  backend_application_id?: string;
}

/** Compose the paste-ready proposal text: chosen opener + body. */
export function composeProposal(p: Proposal): string {
  const opener = (p.openers[p.selected_opener] ?? p.openers[0] ?? "").trim();
  return [opener, p.body.trim()].filter(Boolean).join("\n\n");
}
