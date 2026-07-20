// Type mirrors of the backend's response shapes. Kept in sync by hand —
// they're small enough that codegen isn't worth it. When the backend schema
// changes (Track 6 migration delta), update here.

export interface BackendEvent {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  application_id: string | null;
  device_id: string | null;
  created_at: string;
}

export interface BackendApplication {
  id: string;
  company: string | null;
  role: string | null;
  jd_raw: string;
  requirements: Record<string, unknown> | null;
  status: string;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
  /** Pointer to the most recently rendered cv_versions row for this application. */
  latest_cv_version_id: string | null;
  latest_cv_pdf_key: string | null;
  latest_cv_docx_key: string | null;
  latest_cv_rendered_at: string | null;
}

export interface BackendCvVersion {
  id: string;
  application_id: string | null;
  /** Opaque jsonb. Either the legacy flat `CVSection[]` shape or the
   *  structured `ResumeDoc` object — use `isResumeDoc()` to discriminate. */
  sections: unknown;
  /** Source-upload key (the .pdf/.docx the user originally uploaded). */
  r2_blob_key: string | null;
  /** Rendered PDF key — populated by the cv_render job. */
  r2_pdf_key: string | null;
  /** Rendered DOCX key — populated by the cv_render job. */
  r2_docx_key: string | null;
  label: string | null;
  created_at: string;
}

export interface BackendInterview {
  id: string;
  application_id: string | null;
  started_at: string;
  ended_at: string | null;
  transcript: Array<{ ts: string; kind: "interim" | "final"; text: string }>;
  ai_messages: Array<unknown>;
  r2_audio_key: string | null;
  notes: string | null;
  created_at: string;
}

export interface BackendHealthResponse {
  status: "ok" | "degraded";
  postgres: { ok: boolean; detail: string | null };
  r2: { ok: boolean; detail: string | null };
}

// Request payloads — what the client SENDS.

export interface AppendEventRequest {
  kind: string;
  payload?: Record<string, unknown>;
  application_id?: string | null;
  device_id?: string | null;
}

export interface CreateApplicationRequest {
  jd_raw: string;
  company?: string | null;
  role?: string | null;
  requirements?: Record<string, unknown> | null;
  status?: string | null;
}

export interface PatchApplicationRequest {
  company?: string | null;
  role?: string | null;
  requirements?: Record<string, unknown> | null;
  status?: string | null;
  submitted_at?: string | null;
}

export interface CreateCvVersionRequest {
  application_id?: string | null;
  sections: Array<{ section: string; bullets: string[] }>;
  r2_blob_key?: string | null;
  label?: string | null;
}

export interface StartInterviewRequest {
  application_id?: string | null;
  notes?: string | null;
}

export interface EndInterviewRequest {
  transcript?: Array<{ ts: string; kind: "interim" | "final"; text: string }>;
  ai_messages?: Array<unknown>;
  r2_audio_key?: string | null;
  notes?: string | null;
  ended_at?: string | null;
}

// Generic API error shape — backend returns `{ error: string }` on 4xx/5xx.
export interface BackendErrorBody {
  error: string;
}

// =============================================================================
// Async jobs (Track 17 — render pipeline; reusable for any deferred work)
// =============================================================================

export type JobStatus = "queued" | "running" | "done" | "failed";

export interface BackendJob {
  id: string;
  kind: string;
  status: JobStatus;
  /** Handler-specific output. For `cv_render` this is a `CvRenderResult`. */
  result: Record<string, unknown> | null;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
}

export interface CvRenderResult {
  cv_version_id: string;
  pdf_key: string;
  docx_key: string;
}

export interface EnqueueRenderResponse {
  job_id: string;
  status: JobStatus;
  /** True if the API returned an existing in-flight job instead of a new one. */
  deduped: boolean;
}
