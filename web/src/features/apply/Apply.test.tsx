import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import GapsPage from './GapsPage'
import NewJobPage from './NewJobPage'
import ReviewPage from './ReviewPage'
import RunningPage from './RunningPage'
import WorkspacePage from './WorkspacePage'
import { APP, apiError, brief, gap, json, renderRoute, rewrites, type Call } from './testing'

afterEach(() => vi.unstubAllGlobals())

const JD = 'Senior Backend Engineer at Cobalt Harbor. '.repeat(8)
const is = (c: Call, method: string, path: string) => c.method === method && c.url === path

describe('NewJobPage', () => {
  const open = (api: (c: Call) => Response | undefined = () => undefined) =>
    renderRoute(<NewJobPage />, { path: '/new', pattern: '/new', api })

  it('checks the text and the link on the client before calling the API', async () => {
    const calls = open()
    const u = userEvent.setup()
    await u.click(screen.getByRole('button', { name: 'Tailor my CV' }))
    expect(screen.getByText('Paste the job description first.')).toBeInTheDocument()
    await u.type(screen.getByLabelText('Job description'), 'Go engineer')
    await u.click(screen.getByRole('button', { name: 'Tailor my CV' }))
    expect(screen.getByText(/looks short for a job description/)).toBeInTheDocument()
    await u.click(screen.getByRole('tab', { name: 'Job link' }))
    await u.type(screen.getByLabelText('Link to the job'), 'careers page')
    await u.click(screen.getByRole('button', { name: 'Tailor my CV' }))
    expect(screen.getByText('Paste a full link starting with https://')).toBeInTheDocument()
    expect(calls).toHaveLength(0)
  })

  it('starts the pipeline with the chosen options and goes to Running', async () => {
    const calls = open((c) => (is(c, 'POST', '/v1/applications/start') ? json({ application_id: APP, job_id: 'j1', progress: [] }, 202) : undefined))
    const u = userEvent.setup()
    await u.click(screen.getByLabelText('Job description'))
    await u.paste(JD)
    await u.click(screen.getByRole('switch', { name: 'Draft a cover letter' }))
    await u.click(screen.getByRole('button', { name: 'Tailor my CV' }))
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(`/applications/${APP}/running`))
    expect(calls[0]!.body).toEqual({ jd_text: JD.trim(), research: true, letter: false })
  })

  it('explains a missing master CV and links to the upload', async () => {
    open((c) => (is(c, 'POST', '/v1/applications/start') ? apiError(422, 'no_master_cv', 'Upload your CV first.') : undefined))
    const u = userEvent.setup()
    await u.click(screen.getByLabelText('Job description'))
    await u.paste(JD)
    await u.click(screen.getByRole('button', { name: 'Tailor my CV' }))
    expect(await screen.findByText('Upload your CV first.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Upload your CV' })).toHaveAttribute('href', '/onboarding/upload')
  })

  it('offers the text box when a link cannot be read', async () => {
    open((c) => (is(c, 'POST', '/v1/applications/start') ? apiError(422, 'link_unreadable', 'We could not read that link.') : undefined))
    const u = userEvent.setup()
    await u.click(screen.getByRole('tab', { name: 'Job link' }))
    await u.type(screen.getByLabelText('Link to the job'), 'https://jobs.example.com/1')
    await u.click(screen.getByRole('button', { name: 'Tailor my CV' }))
    expect(await screen.findByText('We could not read that link.')).toBeInTheDocument()
    await u.click(screen.getByRole('button', { name: 'Paste the text instead' }))
    expect(screen.getByRole('tab', { name: 'Paste text' })).toHaveAttribute('aria-selected', 'true')
  })
})

describe('RunningPage', () => {
  const steps = (statuses: string[]) =>
    ['Reading the job', 'Comparing it with your CV', 'Rewriting your strongest bullets', 'Researching the company', 'Drafting your cover letter'].map(
      (label, i) => ({ key: ['read_job', 'compare', 'rewrite', 'research', 'letter'][i], label, status: statuses[i] }),
    )
  const open = (job: unknown, extra: (c: Call) => Response | undefined = () => undefined, b = brief()) =>
    renderRoute(<RunningPage />, {
      path: `/applications/${APP}/running`,
      pattern: '/applications/:id/running',
      api: (c) => (is(c, 'GET', `/v1/applications/${APP}/brief`) ? json(b) : is(c, 'GET', '/v1/jobs/j1') ? json(job) : extra(c)),
    })

  it('shows loading, then the live steps from the job', async () => {
    open({ id: 'j1', status: 'running', progress: steps(['done', 'running', 'pending', 'pending', 'skipped']) })
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Working on it' })).toBeInTheDocument()
    const list = screen.getByRole('list', { name: 'Progress' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(5)
    expect(within(list).getByText('Reading the job')).toBeInTheDocument()
    expect(screen.getByText(/You can close this/)).toBeInTheDocument()
  })

  it('offers the application when the job is done', async () => {
    open({ id: 'j1', status: 'done', progress: steps(['done', 'done', 'done', 'done', 'done']) })
    expect(await screen.findByRole('heading', { name: 'Ready.' })).toBeInTheDocument()
    expect(screen.getByText(/could go from 72 to 86/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /See your application/ })).toHaveAttribute('href', `/applications/${APP}`)
  })

  it('retries a failed job and follows the new one', async () => {
    let retried = false
    const calls = open(
      { id: 'j1', status: 'failed', progress: steps(['done', 'failed', 'pending', 'pending', 'pending']) },
      (c) => {
        if (is(c, 'POST', `/v1/applications/${APP}/pipeline/retry`)) {
          retried = true
          return json({ job_id: 'j2', progress: [] })
        }
        if (is(c, 'GET', '/v1/jobs/j2')) return json({ id: 'j2', status: 'running', progress: steps(['done', 'running', 'pending', 'pending', 'pending']) })
      },
    )
    expect(await screen.findByRole('heading', { name: 'That stopped partway' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { name: 'Working on it' })).toBeInTheDocument()
    expect(retried).toBe(true)
    expect(calls.some((c) => c.url === '/v1/jobs/j2')).toBe(true)
  })

  it('suggests pasting the text when a link could not be read', async () => {
    const b = brief({ application: { ...brief().application, company: null, source_url: 'https://jobs.example.com/1' } })
    open({ id: 'j1', status: 'failed', progress: steps(['failed', 'pending', 'pending', 'pending', 'pending']) }, undefined, b)
    expect(await screen.findByText(/could not read that link/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Paste the text instead' })).toHaveAttribute('href', '/new?mode=text')
  })

  it('shows an error with a retry when the brief does not load', async () => {
    renderRoute(<RunningPage />, {
      path: `/applications/${APP}/running`, pattern: '/applications/:id/running',
      api: () => apiError(503, 'ai_unavailable', 'Paused for a moment.'),
    })
    expect(await screen.findByText('Paused for a moment.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })
})

describe('WorkspacePage', () => {
  const open = (b: unknown) =>
    renderRoute(<WorkspacePage />, {
      path: `/applications/${APP}`, pattern: '/applications/:id',
      api: (c) => (is(c, 'GET', `/v1/applications/${APP}/brief`) ? (b instanceof Response ? b : json(b)) : undefined),
    })

  it('shows the score before and now, and what is left', async () => {
    open(brief())
    const score = await screen.findByRole('region', { name: 'Match score' })
    expect(within(score).getByText('72')).toBeInTheDocument()
    expect(within(score).getByRole('status')).toHaveTextContent('78')
    expect(within(score).getByText('Good match')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /CV tailored.*3 rewrites · 2 waiting for you.*Review/ })).toHaveAttribute('href', `/applications/${APP}/review`)
    expect(screen.getByRole('link', { name: /2 gaps to address.*GraphQL API design/ })).toHaveAttribute('href', `/applications/${APP}/gaps`)
    expect(screen.getByRole('link', { name: /Cover letter.*228 words/ })).toHaveAttribute('href', `/applications/${APP}/letter`)
    expect(screen.getByRole('link', { name: /Send CV/ })).toHaveAttribute('href', `/applications/${APP}/send`)
  })

  it('says when nothing is left to decide', async () => {
    open(brief({
      score: { before: 72, projected: 86, current: 86, rescored: null, decided: 3, pending: 0 },
      gaps: { total: 0, missing: 0, partial: 0, unanswered: 0, top: [] },
      research: null, letter: null,
    }))
    expect(await screen.findByText('Ready to send')).toBeInTheDocument()
    expect(screen.getByText('No gaps found')).toBeInTheDocument()
    expect(screen.getByText('Not drafted yet')).toBeInTheDocument()
  })

  it('sends a still-running application to the Running screen', async () => {
    open(brief({ pipeline: { job_id: 'j1', status: 'running', progress: [] } }))
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(`/applications/${APP}/running`))
  })

  it('handles a missing application', async () => {
    open(apiError(404, 'not_found', 'Not found'))
    expect(await screen.findByText('Application not found')).toBeInTheDocument()
  })
})

describe('ReviewPage', () => {
  function open(initial = rewrites()) {
    let data = initial
    const calls = renderRoute(<ReviewPage />, {
      path: `/applications/${APP}/review`, pattern: '/applications/:id/review',
      api: (c) => {
        if (is(c, 'GET', `/v1/applications/${APP}/brief`)) return json(brief())
        if (is(c, 'GET', `/v1/applications/${APP}/rewrites`)) return json(data)
        if (is(c, 'PATCH', `/v1/applications/${APP}/summary`)) {
          const status = (c.body as { action: string }).action === 'keep' ? 'kept' : 'accepted'
          data = { ...data, summary: { ...data.summary!, status }, score: { ...data.score, current: 75, pending: data.score.pending - 1 } }
          return json({ score: data.score })
        }
        const m = c.url.match(/^\/v1\/rewrites\/(\w+)$/)
        if (c.method === 'PATCH' && m) {
          const body = c.body as { action: string; text?: string }
          const status = ({ accept: 'accepted', keep: 'kept', edit: 'edited' } as const)[body.action as 'accept' | 'keep' | 'edit']
          const rewrite = { ...data.rewrites.find((r) => r.id === m[1])!, status, final_text: body.text ?? null }
          data = { ...data, rewrites: data.rewrites.map((r) => (r.id === rewrite.id ? rewrite : r)), score: { ...data.score, current: 80, pending: data.score.pending - 1 } }
          return json({ rewrite, score: data.score })
        }
      },
    })
    return calls
  }

  it('walks the waiting rewrites one at a time and updates the score', async () => {
    const calls = open()
    expect(await screen.findByRole('heading', { name: '3 left to review' })).toBeInTheDocument()
    expect(screen.getByText('Backend engineer for payment systems.')).toBeInTheDocument()
    expect(screen.getByText('Match 72')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Use rewrite' }))
    expect(await screen.findByRole('heading', { name: '2 left to review' })).toBeInTheDocument()
    expect(screen.getByText('Match 75')).toBeInTheDocument()
    expect(screen.getByText('Led a 4-person on-call rotation.')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Keep original' }))
    expect(await screen.findByRole('heading', { name: '1 left to review' })).toBeInTheDocument()
    expect(screen.getByText(/A number would make this stronger/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const box = screen.getByRole('textbox', { name: 'Edit the rewrite' })
    await userEvent.clear(box)
    await userEvent.type(box, 'Built queues for 2M jobs a day.')
    await userEvent.click(screen.getByRole('button', { name: 'Save and use' }))
    expect(await screen.findByRole('heading', { name: 'All reviewed' })).toBeInTheDocument()
    expect(screen.getByText(/You used 2 of 3 rewrites/)).toBeInTheDocument()

    const patches = calls.filter((c) => c.method === 'PATCH').map((c) => [c.url, c.body])
    expect(patches).toEqual([
      [`/v1/applications/${APP}/summary`, { action: 'accept' }],
      ['/v1/rewrites/r1', { action: 'keep' }],
      ['/v1/rewrites/r2', { action: 'edit', text: 'Built queues for 2M jobs a day.' }],
    ])
  })

  it('never decides anything on its own', async () => {
    const calls = open()
    await screen.findByRole('heading', { name: '3 left to review' })
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0)
  })

  it('lets a decided rewrite be changed', async () => {
    open(rewrites({ summary: null, rewrites: rewrites().rewrites.map((r) => ({ ...r, status: 'accepted' })) }))
    expect(await screen.findByRole('heading', { name: 'All reviewed' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Go through them again' }))
    expect(screen.getByRole('heading', { name: 'Change your choice' })).toBeInTheDocument()
    expect(screen.getByText('Now: using the rewrite')).toBeInTheDocument()
  })

  it('shows an empty state when nothing was suggested', async () => {
    open(rewrites({ summary: null, rewrites: [] }))
    expect(await screen.findByText('Nothing to review')).toBeInTheDocument()
  })
})

describe('GapsPage', () => {
  function open(gaps = [gap(), gap({ id: 'g2', requirement: 'Kafka', status: 'covered' })]) {
    let list = gaps
    return renderRoute(<GapsPage />, {
      path: `/applications/${APP}/gaps`, pattern: '/applications/:id/gaps',
      api: (c) => {
        if (is(c, 'GET', `/v1/applications/${APP}/brief`)) return json(brief())
        if (is(c, 'GET', `/v1/applications/${APP}/gaps`)) return json({ gaps: list })
        if (is(c, 'GET', `/v1/applications/${APP}/cv`)) {
          return json({ doc: { header: { name: 'Ada' }, experience: [{ role: 'Engineer', company: 'Northfold', bullets: [] }, { role: 'Engineer', company: 'Quarry', bullets: [] }], education: [], skills: [] }, issues: [], paper_size: 'a4' })
        }
        if (is(c, 'POST', '/v1/gaps/g1/answer')) {
          const body = c.body as { have: boolean; text?: string; entry?: number }
          const g = body.have
            ? gap({ answer: 'have', answer_text: body.text!, suggested_bullet: 'Designed a GraphQL gateway over three services.', bullet_status: 'pending', target_entry: body.entry! })
            : gap({ answer: 'dont' })
          list = list.map((x) => (x.id === g.id ? g : x))
          return json({ gap: g })
        }
        if (is(c, 'PATCH', '/v1/gaps/g1')) {
          const g = { ...list[0]!, bullet_status: (c.body as { bullet: string }).bullet === 'accept' ? 'accepted' as const : 'discarded' as const }
          list = list.map((x) => (x.id === g.id ? g : x))
          return json({ gap: g })
        }
      },
    })
  }

  it('lists only the gaps, with the question', async () => {
    open()
    expect(await screen.findByRole('heading', { name: 'One gap to look at' })).toBeInTheDocument()
    expect(screen.getByText('Have you designed GraphQL APIs?')).toBeInTheDocument()
    expect(screen.queryByText('Kafka')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Decide later' })).toHaveAttribute('href', `/applications/${APP}`)
  })

  it('turns "I have this" into a suggested bullet that joins the CV only when added', async () => {
    const calls = open()
    const u = userEvent.setup()
    await u.click(await screen.findByRole('button', { name: 'I have this' }))
    await u.type(screen.getByLabelText('Where did you use it?'), 'Built the GraphQL gateway at Quarry for the dashboard.')
    await u.selectOptions(screen.getByLabelText('Which role was it?'), '1')
    await u.click(screen.getByRole('button', { name: 'Write a bullet' }))
    expect(await screen.findByText('Suggested bullet')).toBeInTheDocument()
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ have: true, text: 'Built the GraphQL gateway at Quarry for the dashboard.', entry: 1 })
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false)

    await u.click(screen.getByRole('button', { name: 'Add to this CV' }))
    expect(await screen.findByText('Added to this CV')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'All gaps handled' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Done' })).toBeInTheDocument()
  })

  it('records "I don\'t" and lets the answer change', async () => {
    open()
    await userEvent.click(await screen.findByRole('button', { name: "I don't" }))
    expect(await screen.findByText(/Left out of your CV/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Change my answer' }))
    expect(screen.getByRole('button', { name: 'I have this' })).toBeInTheDocument()
  })

  it('shows an empty state when the CV covers everything', async () => {
    open([gap({ status: 'covered' })])
    expect(await screen.findByText('No gaps')).toBeInTheDocument()
  })
})

describe('WorkspacePage on desktop', () => {
  it('shows rewrites inline beside the CV and decides only on a click', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} }))
    let data = rewrites()
    const calls = renderRoute(<WorkspacePage />, {
      path: `/applications/${APP}`, pattern: '/applications/:id',
      api: (c) => {
        if (is(c, 'GET', `/v1/applications/${APP}/brief`)) return json(brief())
        if (is(c, 'GET', `/v1/applications/${APP}/rewrites`)) return json(data)
        if (is(c, 'GET', `/v1/applications/${APP}/cv`)) {
          return json({ doc: { header: { name: 'Ada Okafor', email: 'ada@example.com' }, summary: 'Backend engineer.', experience: [{ role: 'Engineer', company: 'Northfold', bullets: ['Ran on-call.', 'Built queues.'] }], education: [], skills: [] }, issues: [], paper_size: 'a4' })
        }
        if (is(c, 'PATCH', '/v1/rewrites/r1')) {
          const rewrite = { ...data.rewrites[0]!, status: 'accepted' as const }
          data = { ...data, rewrites: [rewrite, data.rewrites[1]!] }
          return json({ rewrite, score: data.score })
        }
      },
    })
    expect(await screen.findByRole('heading', { name: '3 rewrites need you' })).toBeInTheDocument()
    const cv = await screen.findByRole('region', { name: /Your tailored CV/ })
    expect(within(cv).getByText('Ada Okafor')).toBeInTheDocument()
    expect(within(cv).getByText('Ran on-call.')).toHaveClass('waiting')
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false)

    const item = screen.getByText('Led a 4-person on-call rotation.').closest('li')!
    await userEvent.click(within(item).getByRole('button', { name: 'Use rewrite' }))
    expect(await within(item).findByText('Using the rewrite')).toBeInTheDocument()
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{ action: 'accept' }])
  })
})
