/**
 * Thin client wrapper for the RealmQ Python sidecar.
 *
 * The Tauri Rust side exposes `realmq_sidecar_port` (parsed once at startup
 * from the sidecar's `READY :<port>` line). Everything else here is plain
 * `fetch` to 127.0.0.1:<port>. CORS is permissive on the sidecar because it
 * binds loopback only.
 */

import { invoke } from "@tauri-apps/api/core"

let _port: number | null = null

export async function sidecarPort(): Promise<number> {
  if (_port !== null) return _port
  _port = await invoke<number>("realmq_sidecar_port")
  return _port
}

async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const port = await sidecarPort()
  const res = await fetch(`http://127.0.0.1:${port}${path}`, opts)
  if (!res.ok) {
    let body = ""
    try {
      body = await res.text()
    } catch {
      /* ignore */
    }
    throw new Error(`HTTP ${res.status} on ${path}: ${body || res.statusText}`)
  }
  return (await res.json()) as T
}

// -------- types (mirror the sidecar response shapes) --------

export interface ColumnSchema {
  name: string
  dtype: string
}

export interface Dataset {
  name: string
  domain: string
  description: string
  source_url: string
  license: string
  columns_schema: ColumnSchema[]
  suggested_recipes: string[]
  cached: boolean
}

export interface DatasetSlice {
  name: string
  rows: number
  columns: ColumnSchema[]
  records: Record<string, unknown>[]
}

export interface Recipe {
  name: string
  description: string
  params: Record<string, unknown>
}

export interface RenderRequest {
  recipe_id: string
  dataset_id: string
  params?: Record<string, unknown>
  seed?: number
}

export interface RenderResponse {
  recipe_id: string
  dataset_id: string
  png_b64: string
  records: Record<string, unknown>[]
  metadata: {
    recipe_id: string
    theme: string
    palette: string
    panels: { label: string; type: string; n_series: number }[]
    series: string[]
    y_axis: { label: string; unit: string }
    x_axis: { label: string; type: string }
    rows_used: number
    n_panels: number
    n_series: number
    fingerprint: string
    suitability_score: number
  }
}

export interface Health {
  status: string
  version: string
}

// -------- compute (module 05) --------

export interface ComputeRequest {
  records: Record<string, unknown>[]
  expression: string
}

export interface ComputeResponse {
  expression: string
  value: unknown
  value_type: string
}

// -------- ideation (module 10) --------

export interface IdeationCandidate {
  angle: string
  reasoning_type: string
  draft_question: string
  format_spec: string
  ideal_answer: string
  verification_expression: string
  trap_value: string
  predicted_difficulty: number
  policy_check: {
    binary?: boolean
    ambiguous?: boolean
    external_knowledge?: boolean
    caption_only?: boolean
    decorative_constraint?: boolean
  }
}

export interface IdeateRequest {
  image_b64: string
  dataset_name: string
  dataset_description?: string
  chart_metadata?: Record<string, unknown>
  records?: Record<string, unknown>[]
  reasoning_type?: "chart" | "counting" | "spatial" | "puzzle" | "stem" | "structured-text"
  n_candidates?: number
  vendor?: "claude" | "openai" | "moonshot" | "deepseek" | "deepseek_hybrid"
}

export interface IdeateResponse {
  model: string
  candidates: IdeationCandidate[]
  rejected: (IdeationCandidate & { _rejected_reasons: string[] })[]
  n_returned: number
  n_kept: number
}

// -------- precheck (module 07) --------

export interface PrecheckRequest {
  image_b64: string
  question: string
  answer: string
  format_spec?: string
  runs_per_model?: number
  run_kimi?: boolean
}

export interface PrecheckRun {
  model: string
  full_response: string
  extracted_answer: string
  passed: boolean
}

export interface PrecheckModelReport {
  model: string
  pass_rate: number
  n_passed: number
  n_runs: number
  threshold: number
  verdict: "pass" | "too_easy" | "unclear" | "skipped"
  runs: PrecheckRun[]
}

export interface PrecheckResponse {
  submittable: boolean
  difficulty_pass: boolean
  quality_pass: boolean
  quality_gate_enabled: boolean
  gpt: PrecheckModelReport
  kimi: PrecheckModelReport
  question: string
  canonical_answer: string
}

// -------- tasks + R11 (module 06 + 08) --------

export interface PrecheckSummary {
  submittable: boolean
  difficulty_pass: boolean
  quality_pass: boolean
  gpt_pass_rate: number
  kimi_pass_rate: number | null
  quality_gate_enabled?: boolean
}

export interface TaskCreatePayload {
  dataset_name: string
  recipe_id: string
  chart_fingerprint: string
  reasoning_type?: string
  question: string
  ideal_answer: string
  format_spec: string
  verification_expression?: string
  trap_value?: string
  notes?: string
  precheck?: PrecheckSummary | null
}

export interface TaskRecord extends TaskCreatePayload {
  id: string
  created_at: string
  created_at_epoch: number
}

export interface PairUsage {
  dataset_name: string
  recipe_id: string
  count: number
  last_used_epoch: number
}

export interface UsageResponse {
  by_pair: PairUsage[]
  by_dataset: Record<string, number>
  by_recipe: Record<string, number>
  by_fingerprint: Record<string, number>
  total: number
}

export interface SimilarityCheckRequest {
  text: string
  against?: string[]
  include_saved?: boolean
}

export interface SimilarityCheckResponse {
  max_score: number
  match: string | null
  blocked: boolean
  threshold: number
  pool_size: number
}

// -------- typed helpers --------

export const sidecar = {
  health: () => api<Health>("/health"),
  datasets: () => api<Dataset[]>("/datasets"),
  slice: (name: string, limit = 200) =>
    api<DatasetSlice>(
      `/datasets/${encodeURIComponent(name)}/slice?limit=${limit}`
    ),
  recipes: (opts?: { dataset?: string }) =>
    api<Recipe[]>(
      opts?.dataset
        ? `/recipes?dataset=${encodeURIComponent(opts.dataset)}`
        : "/recipes"
    ),
  render: (req: RenderRequest) =>
    api<RenderResponse>("/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ params: {}, seed: 42, ...req }),
    }),
  compute: (req: ComputeRequest) =>
    api<ComputeResponse>("/compute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    }),
  precheck: (req: PrecheckRequest) =>
    api<PrecheckResponse>("/precheck", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runs_per_model: 4, format_spec: "", ...req }),
    }),
  ideate: (req: IdeateRequest) =>
    api<IdeateResponse>("/ideate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        n_candidates: 5,
        reasoning_type: "chart",
        vendor: "claude",
        ...req,
      }),
    }),
  similarityCheck: (req: SimilarityCheckRequest) =>
    api<SimilarityCheckResponse>("/tasks/similarity-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ include_saved: true, against: [], ...req }),
    }),
  tasks: {
    list: () => api<TaskRecord[]>("/tasks"),
    usage: () => api<UsageResponse>("/tasks/usage"),
    save: (payload: TaskCreatePayload) =>
      api<TaskRecord>("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
    delete: (id: string) =>
      api<{ deleted: boolean; id: string }>(`/tasks/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
  },
}
