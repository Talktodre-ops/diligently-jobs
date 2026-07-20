// Cover letter types (Phase 3, M2). Mirror of the Rust `CoverLetterDoc` in
// backend/src/render/mod.rs — keep both in sync.

import type { ResearchSource } from "./research.type";

export interface CoverLetterDoc {
  candidate_name: string;
  /** "email · linkedin · phone" line under the name. */
  candidate_contact?: string | null;
  date?: string | null;
  /** e.g. "Hiring Manager". */
  recipient?: string | null;
  company?: string | null;
  role?: string | null;
  /** e.g. "Dear Hiring Manager," */
  greeting?: string | null;
  /** AIDA body — one string per paragraph. */
  paragraphs: string[];
  /** e.g. "Sincerely," */
  signoff?: string | null;
}

export interface CoverLetter {
  doc: CoverLetterDoc;
  sources: ResearchSource[];
  generatedAt: number;
}
