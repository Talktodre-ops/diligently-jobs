// Test helpers for the apply and home screens: a fake API keyed by
// "METHOD /path" and a memory router with the routes these screens link to.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { vi } from 'vitest'
import type { Brief, Gap, Rewrites } from './api'

export type Call = { method: string; url: string; body: unknown }
export type Handler = (call: Call) => Response | undefined

export const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
export const apiError = (status: number, code: string, message: string, field?: string) =>
  json({ error: { code, message, field } }, status)

function Where() {
  const l = useLocation()
  return <div data-testid="where">{l.pathname + l.search}</div>
}

/** Renders `ui` at `path` (matched by `pattern`); unknown requests get a 404. */
export function renderRoute(ui: ReactElement, { path, pattern, api }: { path: string; pattern: string; api: Handler }) {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const call = { method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(init.body as string) : undefined }
      calls.push(call)
      return api(call) ?? apiError(404, 'not_found', 'Not found')
    }),
  )
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={pattern} element={<>{ui}<Where /></>} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return calls
}

export const APP = 'a1'

export function brief(over: Partial<Brief> = {}): Brief {
  return {
    application: { id: APP, company: 'Cobalt Harbor', role: 'Senior Backend Engineer', status: 'draft', source_url: null, location: 'Remote', summary: null, created_at: '' },
    pipeline: { job_id: 'j1', status: 'done', progress: [] },
    score: { before: 72, projected: 86, current: 78, rescored: null, decided: 1, pending: 2 },
    rewrites: { total: 2, pending: 1, accepted: 1, kept: 0, edited: 0 },
    summary: { proposed: true, status: 'pending' },
    gaps: { total: 3, missing: 1, partial: 1, unanswered: 2, top: ['GraphQL API design', 'SOC 2 audits'] },
    research: { overview: 'Series A, freight payments', talking_points: 3 },
    letter: { id: 'l1', tone: 'direct', words: 228 },
    ...over,
  }
}

export function rewrites(over: Partial<Rewrites> = {}): Rewrites {
  return {
    summary: { original: 'Backend engineer.', proposed: 'Backend engineer for payment systems.', status: 'pending' },
    rewrites: [
      { id: 'r1', bullet_id: 'E1.B1', section: 'Northfold', original: 'Ran on-call.', rewrite: 'Led a 4-person on-call rotation.', why: 'The job asks for on-call leadership.', needs_number: false, status: 'pending', final_text: null },
      { id: 'r2', bullet_id: 'E1.B2', section: 'Northfold', original: 'Built queues.', rewrite: 'Built Postgres-backed queues.', why: 'Add how many jobs a day.', needs_number: true, status: 'pending', final_text: null },
    ],
    score: { before: 72, projected: 86, current: 72, rescored: null, decided: 0, pending: 3 },
    ...over,
  }
}

export function gap(over: Partial<Gap> = {}): Gap {
  return {
    id: 'g1', application_id: APP, requirement: 'GraphQL API design', importance: 'nice_to_have', status: 'missing',
    evidence: null, ask: 'Have you designed GraphQL APIs?', answer: null, answer_text: null, suggested_bullet: null,
    bullet_status: null, target_entry: null, ...over,
  }
}
