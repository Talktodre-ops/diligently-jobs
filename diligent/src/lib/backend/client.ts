// Thin typed fetch wrapper for the Diligently backend.
//
// Every authenticated call goes through `request()` which adds the bearer
// token from `VITE_BEARER_TOKEN`. `/health` is the one public endpoint and
// uses `requestPublic()`.
//
// Errors come back as `BackendError` with status + body so callers can
// distinguish "401 wrong token" from "503 backend down" from "400 bad input".

import { drainQueue, enqueueEvent } from "./queue";
import { isResumeDoc, type ResumeDoc } from "@/types";
import type {
  AppendEventRequest,
  BackendApplication,
  BackendCvVersion,
  BackendErrorBody,
  BackendEvent,
  BackendHealthResponse,
  BackendInterview,
  BackendJob,
  CreateApplicationRequest,
  CreateCvVersionRequest,
  EndInterviewRequest,
  EnqueueRenderResponse,
  PatchApplicationRequest,
  StartInterviewRequest,
} from "./types";

const BASE_URL = (import.meta.env.VITE_BACKEND_URL || "http://localhost:8787").replace(/\/$/, "");
const TOKEN = import.meta.env.VITE_BEARER_TOKEN || "";
const DEVICE_ID = import.meta.env.VITE_DEVICE_ID || "diligently-unknown";

export class BackendError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: BackendErrorBody | string,
    message?: string
  ) {
    super(message ?? `backend error ${status}`);
    this.name = "BackendError";
  }
}

async function request<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  options?: { signal?: AbortSignal; timeoutMs?: number }
): Promise<T> {
  const url = `${BASE_URL}${path}`;
  // Hard timeout so a hung fetch (DNS, dropped connection, webview quirk)
  // surfaces as an error in the UI instead of an infinite spinner.
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs);
  if (options?.signal) {
    if (options.signal.aborted) ctrl.abort(options.signal.reason);
    else options.signal.addEventListener("abort", () => ctrl.abort(options.signal!.reason), { once: true });
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    // Network failure or timeout (AbortError). Surface as BackendError so
    // callers can distinguish from API-level 4xx/5xx.
    console.error(`[backend] ${method} ${path} failed:`, err);
    throw new BackendError(0, String(err), `${method} ${path} → network/timeout: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timeoutId);
  }
  if (!res.ok) {
    let parsed: BackendErrorBody | string;
    try {
      parsed = (await res.json()) as BackendErrorBody;
    } catch {
      parsed = await res.text();
    }
    const detail =
      typeof parsed === "string" ? parsed : parsed.error ?? JSON.stringify(parsed);
    throw new BackendError(res.status, parsed, `${method} ${path} → ${res.status}: ${detail}`);
  }
  // 204s or empty bodies — return undefined cast to T (caller knows the shape).
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

async function requestPublic<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`);
  if (!res.ok) {
    throw new BackendError(res.status, await res.text(), `GET ${path} → ${res.status}`);
  }
  return (await res.json()) as T;
}

// =============================================================================
// Health
// =============================================================================

export async function getHealth(): Promise<BackendHealthResponse> {
  return requestPublic<BackendHealthResponse>("/health");
}

// =============================================================================
// Events — with offline queue. If the network/backend is down, the event
// gets buffered in localStorage and retried on the next successful call.
// =============================================================================

async function rawAppendEvent(event: AppendEventRequest): Promise<BackendEvent> {
  // Inject device_id if the caller didn't override it.
  const withDevice: AppendEventRequest = {
    ...event,
    device_id: event.device_id ?? DEVICE_ID,
  };
  return request<BackendEvent>("POST", "/v1/events", withDevice);
}

/**
 * Append an event. Never throws on transient backend failure — buffers
 * silently into the offline queue. Throws only on 4xx (caller's fault).
 */
export async function appendEvent(event: AppendEventRequest): Promise<void> {
  try {
    await rawAppendEvent(event);
  } catch (err) {
    if (err instanceof BackendError && err.status >= 400 && err.status < 500) {
      // Our request was wrong — don't silently swallow.
      throw err;
    }
    // Network / 5xx — buffer and move on.
    enqueueEvent(event);
  }
}

/** Drains the offline event queue. Call on startup + after each successful write. */
export async function flushEventQueue(): Promise<{ drained: number; remaining: number }> {
  return drainQueue(async (event) => {
    await rawAppendEvent(event);
  });
}

// =============================================================================
// Applications
// =============================================================================

export async function createApplication(
  req: CreateApplicationRequest
): Promise<BackendApplication> {
  return request<BackendApplication>("POST", "/v1/applications", req);
}

export async function patchApplication(
  id: string,
  req: PatchApplicationRequest
): Promise<BackendApplication> {
  return request<BackendApplication>("PATCH", `/v1/applications/${id}`, req);
}

// =============================================================================
// Company research (Phase 3, M1) — brief synthesized on the desktop, stored here
// =============================================================================

export interface BackendCompanyResearch {
  id: string;
  application_id: string;
  brief: unknown;
  sources: unknown;
  created_at: string;
}

export async function createCompanyResearch(
  applicationId: string,
  req: { brief: unknown; sources?: unknown }
): Promise<BackendCompanyResearch> {
  return request<BackendCompanyResearch>(
    "POST",
    `/v1/applications/${applicationId}/research`,
    req
  );
}

/** Fetch the latest stored brief, or null if none exists (404). */
export async function getCompanyResearch(
  applicationId: string
): Promise<BackendCompanyResearch | null> {
  try {
    return await request<BackendCompanyResearch>(
      "GET",
      `/v1/applications/${applicationId}/research`
    );
  } catch (err) {
    if (err instanceof BackendError && err.status === 404) return null;
    throw err;
  }
}

// =============================================================================
// Cover letters (Phase 3, M2) — render reuses the job worker, like cv-versions
// =============================================================================

export interface BackendCoverLetter {
  id: string;
  application_id: string;
  body: string;
  sources: unknown;
  doc: unknown;
  r2_pdf_key: string | null;
  r2_docx_key: string | null;
  generated_at: string;
}

export async function createCoverLetter(
  applicationId: string,
  req: { body: string; doc: unknown; sources?: unknown }
): Promise<BackendCoverLetter> {
  return request<BackendCoverLetter>(
    "POST",
    `/v1/applications/${applicationId}/cover-letters`,
    req
  );
}

export async function enqueueCoverLetterRender(
  coverLetterId: string
): Promise<EnqueueRenderResponse> {
  return request<EnqueueRenderResponse>(
    "POST",
    `/v1/cover-letters/${coverLetterId}/render`
  );
}

// =============================================================================
// Upwork proposals (Track 20) — AIDA proposals; no render (copy-paste artifact)
// =============================================================================

export interface BackendProposal {
  id: string;
  application_id: string;
  openers: unknown;
  selected_opener: number;
  body: string;
  strategy: string;
  proposal_length: string;
  angle: string | null;
  projects: unknown;
  screening: unknown;
  created_at: string;
}

export async function createProposal(
  applicationId: string,
  req: {
    openers?: string[];
    selected_opener?: number;
    body: string;
    strategy?: string;
    proposal_length?: string;
    angle?: string | null;
    projects?: unknown;
    screening?: unknown;
  }
): Promise<BackendProposal> {
  return request<BackendProposal>(
    "POST",
    `/v1/applications/${applicationId}/proposals`,
    req
  );
}

/** Fetch the latest stored proposal, or null if none exists (404). */
// =============================================================================
// CV versions
// =============================================================================

export async function createCvVersion(req: CreateCvVersionRequest): Promise<BackendCvVersion> {
  return request<BackendCvVersion>("POST", "/v1/cv-versions", req);
}

export async function listCvVersions(opts?: {
  application_id?: string;
  base_only?: boolean;
  limit?: number;
}): Promise<BackendCvVersion[]> {
  const qs = new URLSearchParams();
  if (opts?.application_id) qs.set("application_id", opts.application_id);
  if (opts?.base_only !== undefined) qs.set("base_only", String(opts.base_only));
  if (opts?.limit !== undefined) qs.set("limit", String(opts.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return request<BackendCvVersion[]>("GET", `/v1/cv-versions${suffix}`);
}

/**
 * Fetch the most recent structured base CV from the DB. Throws on backend
 * failure (the caller surfaces it — base CV is now DB-sourced, so a failed
 * load is meaningful, not silently swallowed).
 *
 * Selection priority (rows come back newest-first):
 *   1. latest row labeled "base-structured" / "base" that is a ResumeDoc
 *   2. otherwise any structured row (e.g. a "base-export-structured" snapshot)
 *   3. null when no structured base CV exists yet
 *
 * The label filter keeps us from mistaking a tailored-export snapshot (which
 * also has application_id = null) for the canonical base CV.
 */
export async function getLatestBaseResumeDoc(): Promise<ResumeDoc | null> {
  const rows = await listCvVersions({ base_only: true, limit: 50 });
  const baseLabels = new Set(["base-structured", "base"]);
  for (const row of rows) {
    if (row.label && baseLabels.has(row.label) && isResumeDoc(row.sections)) {
      return row.sections;
    }
  }
  for (const row of rows) {
    if (isResumeDoc(row.sections)) {
      return row.sections;
    }
  }
  return null;
}

/**
 * Enqueue an async PDF + DOCX render of a stored CV version.
 *
 * Returns the job id immediately (the desktop should NOT block on rendering).
 * Poll `getJob(job_id)` until `status: "done"`, then read `result.pdf_key` /
 * `result.docx_key` and use `presignDownload` to get fetchable URLs.
 *
 * Idempotent: if a render is already in-flight for this CV, the same job id
 * comes back with `deduped: true`.
 */
export async function enqueueCvRender(
  cvVersionId: string
): Promise<EnqueueRenderResponse> {
  return request<EnqueueRenderResponse>(
    "POST",
    `/v1/cv-versions/${cvVersionId}/render`
  );
}

export async function getJob(jobId: string): Promise<BackendJob> {
  return request<BackendJob>("GET", `/v1/jobs/${jobId}`);
}

/**
 * Poll a job until it reaches `done` or `failed`. Throws on `failed`.
 * The default `intervalMs` is 800ms — fast enough that a typical render
 * (~1-3s) feels instant in the UI without spamming the backend.
 */
export async function waitForJob(
  jobId: string,
  opts?: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal }
): Promise<BackendJob> {
  const interval = opts?.intervalMs ?? 800;
  const timeout = opts?.timeoutMs ?? 60_000;
  const start = Date.now();
  for (;;) {
    if (opts?.signal?.aborted) throw new Error("waitForJob aborted");
    const job = await getJob(jobId);
    if (job.status === "done") return job;
    if (job.status === "failed") {
      throw new Error(job.last_error ?? `job ${jobId} failed`);
    }
    if (Date.now() - start > timeout) {
      throw new Error(`job ${jobId} did not complete within ${timeout}ms`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

// =============================================================================
// Interviews
// =============================================================================

export async function startInterview(req: StartInterviewRequest): Promise<BackendInterview> {
  return request<BackendInterview>("POST", "/v1/interviews", req);
}

export async function endInterview(
  id: string,
  req: EndInterviewRequest
): Promise<BackendInterview> {
  return request<BackendInterview>("PATCH", `/v1/interviews/${id}`, req);
}

// =============================================================================
// Blobs (R2 presigning)
// =============================================================================

export interface PresignResponse {
  url: string;
  key: string;
  expires_at: string;
}

export async function presignUpload(
  key: string,
  content_type: string,
  ttl_seconds = 300
): Promise<PresignResponse> {
  return request<PresignResponse>("POST", "/v1/blobs/presign-upload", {
    key,
    content_type,
    ttl_seconds,
  });
}

export async function presignDownload(
  key: string,
  ttl_seconds = 300,
  /** Pass e.g. `attachment; filename="cv.pdf"` to force a real download
   *  instead of inline preview. Omit for an inline-viewable URL (iframe). */
  content_disposition?: string
): Promise<PresignResponse> {
  return request<PresignResponse>("POST", "/v1/blobs/presign-download", {
    key,
    ttl_seconds,
    content_disposition,
  });
}
