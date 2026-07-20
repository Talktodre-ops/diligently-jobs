// Follow-up plan types (Phase 3, M3).
//
// A cadence of follow-up actions (who to reach, on what channel, when) with an
// AI-drafted message for each. Stored on the workspace; logged to the events
// spine. No people-scraping — roles + channels + cadence + drafts only.

export interface FollowUp {
  id: string;
  /** Short label, e.g. "Recruiter nudge". */
  label: string;
  /** When to send, relative to applying, e.g. "3 days after applying". */
  timing: string;
  /** Channel, e.g. "LinkedIn", "Email", "Application portal". */
  channel: string;
  /** Who to target, e.g. "Recruiter / Talent partner". */
  target: string;
  /** AI-drafted message. Editable. */
  draft: string;
  status: "pending" | "done";
}

export interface FollowUpPlan {
  followups: FollowUp[];
  generatedAt: number;
}
