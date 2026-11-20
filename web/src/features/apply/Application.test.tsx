import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ApplicationPage from './ApplicationPage'
import { OldApplicationRoute } from './OldApplicationRoute'
import type { Gap, Rewrites, Step } from './api'
import { APP, apiError, brief, gap, json, renderRoute, rewrites, type Call } from './testing'

afterEach(() => {
  vi.unstubAllGlobals()
})

const is = (c: Call, method: string, path: string) => c.method === method && c.url === path
const where = () => screen.getByTestId('where').textContent ?? ''

const steps = (statuses: string[]): Step[] =>
  ['Reading the job', 'Comparing it with your CV', 'Rewriting your strongest bullets', 'Researching the company', 'Drafting your cover letter'].map(
    (label, i) => ({ key: ['read_job', 'compare', 'rewrite', 'research', 'letter'][i]!, label, status: statuses[i] as Step['status'] }),
  )

// The CV as the server sends it: suggestions are already in it.
const cvDoc = {
  doc: {
    header: { name: 'Ada Okafor', email: 'ada@example.com' },
    summary: 'Backend engineer for payment systems.',
    experience: [
      { role: 'Engineer', company: 'Northfold', bullets: ['Led a 4-person on-call rotation.', 'Built Postgres-backed queues.'] },
      { role: 'Engineer', company: 'Quarry', bullets: ['Shipped the billing dashboard.'] },
    ],
    education: [], skills: [],
  },
  issues: [], paper_size: 'a4',
}

/** A fake API that remembers decisions, the way the server does. */
function server(opts: { rewrites?: Rewrites; gaps?: Gap[]; extra?: (c: Call) => Response | undefined } = {}) {
  let data = opts.rewrites ?? rewrites()
  let gaps = opts.gaps ?? [gap({ status: 'covered' })]
  const status = (action: string) => (action === 'keep' ? 'kept' : action === 'edit' ? 'edited' : 'accepted')
  return (c: Call): Response | undefined => {
    const extra = opts.extra?.(c)
    if (extra) return extra
    if (is(c, 'GET', `/v1/applications/${APP}/brief`)) return json(brief())
    if (is(c, 'GET', `/v1/applications/${APP}/rewrites`)) return json(data)
    if (is(c, 'GET', `/v1/applications/${APP}/cv`)) return json(cvDoc)
    if (is(c, 'GET', `/v1/applications/${APP}/gaps`)) return json({ gaps })
    if (c.method === 'PATCH' && c.url.startsWith('/v1/rewrites/')) {
      const id = c.url.split('/').pop()
      const body = c.body as { action: string; text?: string }
      const rewrite = { ...data.rewrites.find((r) => r.id === id)!, status: status(body.action) as never, final_text: body.text ?? null }
      data = { ...data, rewrites: data.rewrites.map((r) => (r.id === id ? rewrite : r)) }
      return json({ rewrite, score: data.score })
    }
    if (is(c, 'PATCH', `/v1/applications/${APP}/summary`)) {
      const body = c.body as { action: string; text?: string }
      data = { ...data, summary: { ...data.summary!, status: status(body.action), proposed: body.text ?? data.summary!.proposed } }
      return json({ score: data.score })
    }
    if (is(c, 'POST', '/v1/gaps/g1/answer')) {
      const body = c.body as { have: boolean; text?: string; entry?: number }
      const g = body.have
        ? gap({ answer: 'have', answer_text: body.text!, suggested_bullet: 'Designed a GraphQL gateway over three services.', bullet_status: 'pending', target_entry: body.entry! })
        : gap({ answer: 'dont' })
      gaps = gaps.map((x) => (x.id === g.id ? g : x))
      return json({ gap: g })
    }
    if (is(c, 'PATCH', '/v1/gaps/g1')) {
      const g = { ...gaps.find((x) => x.id === 'g1')!, bullet_status: (c.body as { bullet: string }).bullet === 'accept' ? 'accepted' as const : 'discarded' as const }
      gaps = gaps.map((x) => (x.id === g.id ? g : x))
      return json({ gap: g })
    }
    return undefined
  }
}

const open = (api: (c: Call) => Response | undefined, query = '') =>
  renderRoute(<ApplicationPage />, { path: `/applications/${APP}${query}`, pattern: '/applications/:id', api })

describe('tailoring in place', () => {
  const running = (job: unknown, extra?: (c: Call) => Response | undefined, b = brief({ pipeline: { job_id: 'j1', status: 'running', progress: [] } })) =>
    open((c) => {
      const out = extra?.(c)
      if (out) return out
      if (is(c, 'GET', `/v1/applications/${APP}/brief`)) return json(b)
      if (is(c, 'GET', '/v1/jobs/j1')) return json(job)
      return undefined
    })

  it('shows the live steps above the tabs and holds Send until the CV is ready', async () => {
    const calls = running({ id: 'j1', status: 'running', progress: steps(['done', 'running', 'pending', 'pending', 'skipped']) })
    expect(await screen.findByRole('heading', { name: 'Tailoring your CV' })).toBeInTheDocument()
    const list = screen.getByRole('list', { name: 'Progress' })
    expect(await within(list).findAllByRole('listitem')).toHaveLength(5)
    expect(within(list).getByText('Comparing it with your CV')).toBeInTheDocument()
    expect(screen.getByText(/as soon as the rewrites are ready/)).toBeInTheDocument()
    expect(screen.getByText('Send opens when your CV is ready.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    expect(screen.queryByRole('region', { name: 'Match score' })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('tab', { name: 'Letter' }))
    expect(screen.getByText(/Your letter is written after the CV/)).toBeInTheDocument()
    // Nothing that only exists at the end is asked for while it runs.
    expect(calls.some((c) => c.url.endsWith('/rewrites') || c.url.endsWith('/cover-letters'))).toBe(false)
  })

  it('opens the CV in place when the run finishes', async () => {
    let briefs = 0
    open(server({
      extra: (c) => {
        if (is(c, 'GET', `/v1/applications/${APP}/brief`)) {
          briefs += 1
          return json(briefs === 1 ? brief({ pipeline: { job_id: 'j1', status: 'running', progress: [] } }) : brief())
        }
        if (is(c, 'GET', '/v1/jobs/j1')) return json({ id: 'j1', status: 'done', progress: steps(['done', 'done', 'done', 'done', 'done']) })
      },
    }))
    expect(await screen.findByRole('article', { name: 'Your tailored CV' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Tailoring your CV' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled()
    expect(where()).toBe(`/applications/${APP}`)
  })

  it('retries a stopped run and follows the new job', async () => {
    let retried = false
    const calls = running(
      { id: 'j1', status: 'failed', progress: steps(['done', 'failed', 'pending', 'pending', 'pending']) },
      (c) => {
        if (is(c, 'POST', `/v1/applications/${APP}/pipeline/retry`)) { retried = true; return json({ job_id: 'j2', progress: [] }) }
        if (is(c, 'GET', '/v1/jobs/j2')) return json({ id: 'j2', status: 'running', progress: steps(['done', 'running', 'pending', 'pending', 'pending']) })
      },
      brief({ pipeline: { job_id: 'j1', status: 'failed', progress: [] } }),
    )
    expect(await screen.findByRole('heading', { name: 'That stopped partway' })).toBeInTheDocument()
    expect(screen.getByText(/Steps that worked are kept/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { name: 'Tailoring your CV' })).toBeInTheDocument()
    expect(retried).toBe(true)
    expect(calls.some((c) => c.url === '/v1/jobs/j2')).toBe(true)
  })

  it('suggests pasting the text when a link could not be read', async () => {
    const b = brief({ application: { ...brief().application, company: null, source_url: 'https://jobs.example.com/1' }, pipeline: { job_id: 'j1', status: 'failed', progress: [] } })
    running({ id: 'j1', status: 'failed', progress: steps(['failed', 'pending', 'pending', 'pending', 'pending']) }, undefined, b)
    expect(await screen.findByText(/could not read that link/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Paste the text instead' })).toHaveAttribute('href', '/new?mode=text')
    expect(screen.getByText('New job')).toBeInTheDocument()
  })

  it('follows the job passed from New job before the brief knows it', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url)
      if (url === `/v1/applications/${APP}/brief`) return json(brief({ pipeline: null }))
      if (url === '/v1/jobs/j9') return json({ id: 'j9', status: 'running', progress: steps(['running', 'pending', 'pending', 'pending', 'pending']) })
      return apiError(404, 'not_found', 'Not found')
    }))
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[{ pathname: `/applications/${APP}`, state: { jobId: 'j9' } }]}>
          <Routes><Route path="/applications/:id" element={<ApplicationPage />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(await screen.findByRole('heading', { name: 'Tailoring your CV' })).toBeInTheDocument()
    expect(calls).toContain('/v1/jobs/j9')
  })

  it('shows an error with a retry, and says when the application is gone', async () => {
    open(() => apiError(503, 'ai_unavailable', 'Paused for a moment.'))
    expect(await screen.findByText('Paused for a moment.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('handles a missing application', async () => {
    open(() => apiError(404, 'not_found', 'Not found'))
    expect(await screen.findByText('Application not found')).toBeInTheDocument()
  })
})

describe('the CV tab', () => {
  it('shows the score, the CV with each change marked, and what goes out', async () => {
    const calls = open(server())
    const score = await screen.findByRole('region', { name: 'Match score' })
    expect(within(score).getByText('72')).toBeInTheDocument()
    expect(within(score).getByRole('status')).toHaveTextContent('78')
    expect(within(score).getByText('Good match')).toBeInTheDocument()

    const cv = await screen.findByRole('article', { name: 'Your tailored CV' })
    const mark = await within(cv).findByRole('link', { name: /Led a 4-person on-call rotation\..*not looked at yet/ })
    expect(mark).toHaveClass('waiting')
    expect(within(cv).getByText('Shipped the billing dashboard.').tagName).toBe('LI')
    expect(screen.getByText(/1 change in your CV/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '2 not looked at yet' })).toBeInTheDocument()
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0)
  })

  it('opens a change from the page, decides it, and moves to the next one not looked at', async () => {
    const calls = open(server())
    const u = userEvent.setup()
    await u.click(await screen.findByRole('link', { name: /Led a 4-person on-call rotation/ }))
    await waitFor(() => expect(where()).toBe(`/applications/${APP}?change=r1`))
    let sheet = screen.getByRole('dialog', { name: 'Northfold · Experience' })
    expect(within(sheet).getByText('Ran on-call.')).toBeInTheDocument()
    expect(within(sheet).getByText('The job asks for on-call leadership.')).toBeInTheDocument()
    expect(within(sheet).getByText('2 of 3')).toBeInTheDocument()

    await u.click(within(sheet).getByRole('button', { name: 'Looks good' }))
    sheet = await screen.findByRole('dialog', { name: 'Northfold · Experience' })
    expect(await within(sheet).findByText('Built queues.')).toBeInTheDocument()
    expect(within(sheet).getByText(/A number would make this stronger/)).toBeInTheDocument()

    await u.click(within(sheet).getByRole('button', { name: 'Keep original' }))
    sheet = await screen.findByRole('dialog', { name: 'Summary' })
    await u.click(within(sheet).getByRole('button', { name: 'Edit' }))
    const box = within(sheet).getByRole('textbox', { name: 'Edit the line' })
    await u.clear(box)
    await u.type(box, 'Backend engineer who keeps payments up.')
    await u.click(within(sheet).getByRole('button', { name: 'Save and use' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(where()).toBe(`/applications/${APP}`)
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => [c.url, c.body])).toEqual([
      ['/v1/rewrites/r1', { action: 'accept' }],
      ['/v1/rewrites/r2', { action: 'keep' }],
      [`/v1/applications/${APP}/summary`, { action: 'edit', text: 'Backend engineer who keeps payments up.' }],
    ])
  })

  it('starts at the first one not looked at, steps through all of them, and closes on Escape', async () => {
    const calls = open(server({ rewrites: rewrites({ summary: { ...rewrites().summary!, status: 'accepted' } }) }), '?change=next')
    const sheet = await screen.findByRole('dialog', { name: 'Northfold · Experience' })
    expect(within(sheet).getByText('Ran on-call.')).toBeInTheDocument()
    await userEvent.click(within(sheet).getByRole('button', { name: /Previous/ }))
    expect(await screen.findByRole('dialog', { name: 'Summary' })).toBeInTheDocument()
    expect(screen.getByText('Using the rewrite')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false)
  })

  it('puts a kept suggestion back', async () => {
    const kept = rewrites({ rewrites: rewrites().rewrites.map((r) => (r.id === 'r1' ? { ...r, status: 'kept' } : r)) })
    const calls = open(server({ rewrites: kept }), '?change=r1')
    const sheet = await screen.findByRole('dialog', { name: 'Northfold · Experience' })
    expect(within(sheet).getByText('Keeping your original')).toBeInTheDocument()
    await userEvent.click(within(sheet).getByRole('button', { name: 'Use the suggestion' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ action: 'accept' }))
  })

  it('opens the first change not looked at from beside Send', async () => {
    open(server())
    await userEvent.click(await screen.findByRole('button', { name: '2 not looked at yet' }))
    expect(await screen.findByRole('dialog', { name: 'Summary' })).toBeInTheDocument()
  })
})

describe('questions above the CV', () => {
  const twoRoles = [gap(), gap({ id: 'g2', requirement: 'Kafka', status: 'covered' })]

  it('asks only what the CV does not show', async () => {
    open(server({ gaps: twoRoles }))
    expect(await screen.findByRole('heading', { name: 'One question would make this stronger' })).toBeInTheDocument()
    expect(screen.getByText('Have you designed GraphQL APIs?')).toBeInTheDocument()
    expect(screen.queryByText('Kafka')).not.toBeInTheDocument()
  })

  it('turns "I have this" into a bullet that joins the CV only when added', async () => {
    const calls = open(server({ gaps: twoRoles }))
    const u = userEvent.setup()
    await u.click(await screen.findByRole('button', { name: 'I have this' }))
    await u.type(screen.getByLabelText('Where did you use it?'), 'Built the GraphQL gateway at Quarry for the dashboard.')
    await u.selectOptions(screen.getByLabelText('Which role was it?'), '1')
    await u.click(screen.getByRole('button', { name: 'Write a bullet' }))
    expect(await screen.findByText('Suggested bullet')).toBeInTheDocument()
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ have: true, text: 'Built the GraphQL gateway at Quarry for the dashboard.', entry: 1 })
    expect(calls.some((c) => c.url === '/v1/gaps/g1')).toBe(false)

    await u.click(screen.getByRole('button', { name: 'Add to this CV' }))
    expect(await screen.findByRole('heading', { name: 'You answered the question' })).toBeInTheDocument()
    await u.click(screen.getByRole('button', { name: 'See answers' }))
    expect(screen.getByText('Added to this CV')).toBeInTheDocument()
  })

  it('records "I don\'t" and lets the answer change', async () => {
    open(server({ gaps: twoRoles }))
    await userEvent.click(await screen.findByRole('button', { name: "I don't" }))
    expect(await screen.findByRole('heading', { name: 'You answered the question' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'See answers' }))
    expect(screen.getByText(/Left out of your CV/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Change my answer' }))
    expect(screen.getByRole('button', { name: 'I have this' })).toBeInTheDocument()
  })

  it('moves a question to the back with Ask me later', async () => {
    open(server({ gaps: [gap(), gap({ id: 'g3', requirement: 'SOC 2 audits', ask: 'Have you been through a SOC 2 audit?' })] }))
    expect(await screen.findByRole('heading', { name: '2 questions would make this stronger' })).toBeInTheDocument()
    expect(screen.getByText('Have you designed GraphQL APIs?')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Ask me later' }))
    expect(screen.getByText('Have you been through a SOC 2 audit?')).toBeInTheDocument()
  })

  it('stays out of the way when the CV covers everything', async () => {
    open(server({ gaps: [gap({ status: 'covered' })] }))
    await screen.findByRole('article', { name: 'Your tailored CV' })
    expect(screen.queryByRole('heading', { name: /question/ })).not.toBeInTheDocument()
  })
})

describe('tabs', () => {
  it('keeps the tab in the address and moves with the arrow keys', async () => {
    open(server({ extra: (c) => (c.url.endsWith('/cover-letters') || c.url.endsWith('/research') ? apiError(404, 'not_found', 'Not found') : undefined) }))
    const cv = await screen.findByRole('tab', { name: 'CV' })
    expect(cv).toHaveAttribute('aria-selected', 'true')
    await userEvent.click(screen.getByRole('tab', { name: 'Letter' }))
    await waitFor(() => expect(where()).toBe(`/applications/${APP}?tab=letter`))
    expect(await screen.findByText('No letter yet')).toBeInTheDocument()
    await userEvent.keyboard('{ArrowRight}')
    await waitFor(() => expect(where()).toBe(`/applications/${APP}?tab=company`))
    expect(screen.getByRole('tab', { name: 'Company' })).toHaveFocus()
    expect(await screen.findByText('No research yet')).toBeInTheDocument()
    await userEvent.keyboard('{ArrowRight}')
    await waitFor(() => expect(where()).toBe(`/applications/${APP}`))
  })

  it('opens Send from the footer', async () => {
    open(server({ extra: (c) => (c.url.endsWith('/cover-letters') ? apiError(404, 'not_found', 'Not found') : undefined) }))
    await userEvent.click(await screen.findByRole('button', { name: 'Send' }))
    await waitFor(() => expect(where()).toBe(`/applications/${APP}?send=1`))
    expect(await screen.findByRole('dialog', { name: 'Send to Cobalt Harbor' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Write one' }))
    await waitFor(() => expect(where()).toBe(`/applications/${APP}?tab=letter`))
  })
})

describe('on desktop', () => {
  it('lists every change beside the CV and decides only on a click', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} }))
    const calls = open(server())
    expect(await screen.findByRole('heading', { name: '3 changes in your CV' })).toBeInTheDocument()
    expect(screen.getByText('3 not looked at')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'All jobs' })).toHaveAttribute('href', '/jobs')
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false)

    const list = screen.getByRole('complementary', { name: 'What to look at' })
    const item = within(list).getAllByRole('listitem').find((li) => li.textContent?.includes('Led a 4-person on-call rotation.'))!
    await userEvent.click(within(item).getByRole('button', { name: 'Looks good' }))
    expect(await within(item).findByText('Using the rewrite')).toBeInTheDocument()
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{ action: 'accept' }])

    await userEvent.click(within(item).getByRole('button', { name: 'Edit' }))
    const sheet = await screen.findByRole('dialog', { name: 'Northfold · Experience' })
    expect(within(sheet).getByRole('textbox', { name: 'Edit the line' })).toHaveValue('Led a 4-person on-call rotation.')
  })
})

describe('addresses from before the one screen', () => {
  function visit(path: string, state?: unknown) {
    vi.stubGlobal('fetch', vi.fn(async () => apiError(404, 'not_found', 'Not found')))
    function At() {
      const l = useLocation()
      return <div data-testid="where">{l.pathname + l.search} {JSON.stringify(l.state)}</div>
    }
    const was = ['running', 'review', 'gaps', 'cv', 'letter', 'research', 'send'] as const
    render(
      <MemoryRouter initialEntries={[{ pathname: path.split('?')[0]!, search: path.includes('?') ? `?${path.split('?')[1]}` : '', state }]}>
        <Routes>
          <Route path="/applications/:id" element={<At />} />
          {was.map((w) => <Route key={w} path={`/applications/:id/${w}`} element={<OldApplicationRoute was={w} />} />)}
        </Routes>
      </MemoryRouter>,
    )
  }

  it.each([
    ['/applications/a1/running', '/applications/a1'],
    ['/applications/a1/gaps', '/applications/a1'],
    ['/applications/a1/cv', '/applications/a1'],
    ['/applications/a1/letter', '/applications/a1?tab=letter'],
    ['/applications/a1/research', '/applications/a1?tab=company'],
    ['/applications/a1/send', '/applications/a1?send=1'],
    ['/applications/a1/review', '/applications/a1?change=next'],
    ['/applications/a1/review?item=r2', '/applications/a1?change=r2'],
  ])('%s lands on %s', async (from, to) => {
    visit(from)
    expect((await screen.findByTestId('where')).textContent).toBe(`${to} null`)
  })

  it('keeps the tailoring job passed from New job', async () => {
    visit('/applications/a1/running', { jobId: 'j1' })
    expect((await screen.findByTestId('where')).textContent).toBe('/applications/a1 {"jobId":"j1"}')
  })
})
