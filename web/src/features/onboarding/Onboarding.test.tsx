import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RequireAccount } from '../../auth/gates'
import { cvCounts, fileProblem, pastedFile, type MasterCv } from './api'
import CheckPage from './CheckPage'
import { countryOf, foundFacts, inferPaper, mergeAnswer, strengthenCandidates } from './cvFacts'
import FirstJobPage, { usageLine } from './FirstJobPage'
import TargetsPage from './TargetsPage'
import UploadPage from './UploadPage'

const me = { id: 'u', email: 'mara@example.com', email_verified: true, plan: 'free', created_at: '' }
const profile = (step: string, extra = {}) => ({
  full_name: null, headline: null, location: null, target_roles: [], work_settings: [], open_to: null, paper_size: 'a4', theme: 'system',
  notifications: { follow_ups: true, interview_prep: true, product_news: false }, onboarding_step: step, updated_at: '', ...extra,
})
const cv = (over: Partial<MasterCv> = {}): MasterCv => ({
  id: 'c',
  doc: {
    header: { name: 'Mara Quill', title: 'Backend Engineer', email: 'mara@example.com' },
    experience: [
      { role: 'Senior Engineer', company: 'Larkspur', start: '2021', end: 'Present', bullets: ['Cut costs by 20%', 'Led the migration to Rust.'] },
      { role: 'Engineer', company: 'Kestrel', start: '', end: '', bullets: ['Mentored juniors'] },
    ],
    education: [{ institution: 'University of Leeds', degree: 'B.Sc. Computer Science' }],
    skills: [{ label: 'Languages', items: ['Go', 'Rust'] }], projects: [],
  },
  issues: [{ path: 'experience[1]', message: 'Dates are missing for Kestrel.' }],
  updated_at: '',
  ...over,
})
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
const usage = { plan: 'free', applications_this_month: 0, monthly_limit: 10, resets_on: '2026-12-01' }

function Where() {
  const loc = useLocation()
  return <div>At {loc.pathname} {JSON.stringify(loc.state)}</div>
}

type Call = { url: string; method: string; body?: BodyInit | null }
type State = { step: string; master: MasterCv | null; profile?: object }
function setup(ui: React.ReactElement, state: State, extra?: (url: string, init?: RequestInit) => Response | undefined, path = '/x') {
  const calls: Call[] = []
  const live = { ...state }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: init?.body })
    const hit = extra?.(url, init)
    if (hit) return hit
    if (url === '/v1/auth/me') return json({ user: me })
    if (url === '/v1/usage') return json(usage)
    if (url === '/v1/profile' && method === 'PATCH') {
      const patch = JSON.parse(init!.body as string)
      live.step = patch.onboarding_step ?? live.step
      live.profile = { ...live.profile, ...patch }
      return json({ profile: profile(live.step, live.profile) })
    }
    if (url === '/v1/profile') return json({ profile: profile(live.step, live.profile) })
    if (url === '/v1/cv/master' && method === 'PUT') {
      const doc = JSON.parse(init!.body as string).doc
      live.master = cv({ doc, issues: [] })
      return json({ cv: live.master })
    }
    if (url === '/v1/cv/master') return live.master ? json({ cv: live.master }) : json({ error: { code: 'no_master_cv', message: 'Upload your CV first.' } }, 422)
    return new Response('{}', { status: 404 })
  }))
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/x" element={ui} />
          <Route path="/" element={<div>Home page</div>} />
          <Route path="/onboarding/upload" element={<div>Upload route</div>} />
          <Route path="/onboarding/check" element={<div>Check route</div>} />
          <Route path="/onboarding/targets" element={<div>Targets route</div>} />
          <Route path="/onboarding/first-job" element={<div>First job route</div>} />
          <Route path="/applications/:id/running" element={<Where />} />
          <Route path="/verify-email" element={<div>Verify route</div>} />
          <Route element={<RequireAccount />}>
            <Route path="/inside" element={<div>Inside the app</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return calls
}
const patches = (calls: Call[]) => calls.filter((c) => c.method === 'PATCH').map((c) => JSON.parse(c.body as string))

afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

describe('helpers', () => {
  it('checks type and size like the API', () => {
    expect(fileProblem(new File(['x'], 'cv.txt'))).toMatch(/PDF or Word/)
    expect(fileProblem(new File([], 'cv.pdf'))).toMatch(/empty/)
    expect(fileProblem(new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'cv.PDF'))).toMatch(/5 MB/)
    expect(fileProblem(new File(['x'], 'cv.docx'))).toBeNull()
  })
  it('sends pasted text as cv.txt', () => {
    const f = pastedFile('  hello  ')
    expect(f.name).toBe('cv.txt')
    expect(f.type).toBe('text/plain')
    expect(f.size).toBe(5)
  })
  it('counts roles, bullets and skills', () => {
    expect(cvCounts(cv().doc)).toEqual({ roles: 2, bullets: 3, skills: 2 })
  })
  it('lists what was read, leaving out what is missing', () => {
    expect(foundFacts(cv().doc)).toEqual([
      { label: 'Name', value: 'Mara Quill' },
      { label: 'Now', value: 'Senior Engineer, Larkspur' },
      { label: 'Before', value: 'Kestrel' },
      { label: 'Skills', value: 'Go, Rust' },
      { label: 'Education', value: 'B.Sc. Computer Science, University of Leeds' },
    ])
    const many = { ...cv().doc, skills: [{ label: 'x', items: ['a', 'b', 'c', 'd', 'e', 'f'] }], education: [] }
    expect(foundFacts(many).find((f) => f.label === 'Skills')?.value).toBe('a, b, c, d and 2 more')
    expect(foundFacts(many).some((f) => f.label === 'Education')).toBe(false)
  })
  it('picks up to three bullets without a digit, most recent role first', () => {
    const doc = cv().doc
    expect(strengthenCandidates(doc).map((c) => c.key)).toEqual(['0.1', '1.0'])
    const lots = { ...doc, experience: [{ ...doc.experience[0]!, bullets: ['a', 'b 2', 'c', 'd', 'e'] }] }
    expect(strengthenCandidates(lots).map((c) => c.text)).toEqual(['a', 'c', 'd'])
  })
  it('merges an answer into a bullet without inventing anything', () => {
    expect(mergeAnswer('Led the migration to Rust.', 'cutting p99 latency by 40%')).toBe('Led the migration to Rust, cutting p99 latency by 40%.')
    expect(mergeAnswer('Mentored juniors', ' 4 engineers. ')).toBe('Mentored juniors, 4 engineers.')
  })
  it('infers paper size from the location', () => {
    expect(inferPaper('Austin, TX, USA')).toBe('letter')
    expect(inferPaper('Toronto, Canada')).toBe('letter')
    expect(inferPaper('New York, United States')).toBe('letter')
    expect(inferPaper('Lagos, Nigeria')).toBe('a4')
    expect(inferPaper('Campus town, Australia')).toBe('a4')
    expect(inferPaper(null)).toBe('a4')
    expect(countryOf('Lagos, Nigeria')).toBe('Nigeria')
    expect(countryOf('')).toBe('')
  })
  it('words the usage line from the plan', () => {
    expect(usageLine(usage)).toBe('Uses 1 of your 10 applications this month')
    expect(usageLine({ ...usage, applications_this_month: 3 })).toBe('Uses 1 of the 7 applications you have left this month')
    expect(usageLine({ ...usage, applications_this_month: 10 })).toMatch(/used all 10/)
    expect(usageLine({ ...usage, monthly_limit: null })).toBeNull()
  })
})

describe('gates', () => {
  it('sends an account at first_job to the first job screen', async () => {
    setup(<div />, { step: 'first_job', master: cv() }, undefined, '/inside')
    expect(await screen.findByText('First job route')).toBeInTheDocument()
  })
  it('lets a finished account in', async () => {
    setup(<div />, { step: 'done', master: cv() }, undefined, '/inside')
    expect(await screen.findByText('Inside the app')).toBeInTheDocument()
  })
})

const uploadReply = (status: string, kind = 'pdf', filename = 'cv.pdf') =>
  json({ upload: { id: 'up1', filename, kind, status, error: null, cv_version_id: status === 'done' ? 'v' : null } })

describe('UploadPage', () => {
  it('shows the four steps with the current one marked', async () => {
    setup(<UploadPage />, { step: 'upload', master: null })
    const steps = await screen.findByRole('list', { name: 'Setup steps' })
    expect(within(steps).getAllByRole('listitem')).toHaveLength(4)
    expect(within(steps).getByText('Your CV').closest('li')).toHaveAttribute('aria-current', 'step')
    expect(screen.getByText('About 3 minutes left')).toBeInTheDocument()
  })

  it('refuses a wrong file type without calling the API', async () => {
    const calls = setup(<UploadPage />, { step: 'upload', master: null })
    const input = await screen.findByLabelText('CV file')
    await userEvent.upload(input, new File(['x'], 'notes.txt', { type: 'text/plain' }), { applyAccept: false })
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose a PDF or Word (DOCX) file.')
    expect(calls.some((c) => c.url === '/v1/cv/upload')).toBe(false)
  })

  it('opens the LinkedIn how-to in place', async () => {
    setup(<UploadPage />, { step: 'upload', master: null })
    const toggle = await screen.findByRole('button', { name: 'No CV? Use your LinkedIn profile' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Tap Resources, then Save to PDF')).toBeInTheDocument()
  })

  it('uploads as multipart, shows staged status, then reveals what was read', async () => {
    let polls = 0
    const live: State = { step: 'upload', master: null }
    const calls = setup(<UploadPage />, live, (url) => {
      if (url === '/v1/cv/upload') return json({ upload: { id: 'up1', filename: 'cv.pdf', kind: 'pdf', status: 'queued', error: null, cv_version_id: null }, job_id: 'j' }, 202)
      if (url === '/v1/cv/uploads/up1') {
        polls++
        if (polls > 1) live.master = cv()
        return uploadReply(polls > 1 ? 'done' : 'reading')
      }
      if (url === '/v1/cv/master') return live.master ? json({ cv: live.master }) : json({ error: { code: 'no_master_cv', message: 'x' } }, 422)
      return undefined
    })
    await userEvent.upload(await screen.findByLabelText('CV file'), new File(['%PDF'], 'cv.pdf', { type: 'application/pdf' }))
    const sent = calls.find((c) => c.url === '/v1/cv/upload')!
    expect(sent.body).toBeInstanceOf(FormData)
    expect((sent.body as FormData).get('file')).toBeInstanceOf(File)
    expect(await screen.findByRole('status', {}, { timeout: 3000 })).toHaveTextContent(/Uploading|Opening the file|Reading your roles/)
    expect(await screen.findByRole('heading', { name: 'That is you, right?' }, { timeout: 5000 })).toBeInTheDocument()
    const found = screen.getByRole('list', { name: 'What we read' })
    await waitFor(() => expect(within(found).getByText('B.Sc. Computer Science, University of Leeds')).toBeInTheDocument(), { timeout: 4000 })
    expect(within(found).getByText('Mara Quill')).toBeInTheDocument()
    expect(screen.getByText(/^Read in full/)).toBeInTheDocument()
    expect(screen.getByText('1 thing to check on the next screen')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Looks like me, continue' }))
    expect(await screen.findByText('Check route')).toBeInTheDocument()
  }, 15_000)

  it('checks pasted text on the client, then sends it as cv.txt', async () => {
    const calls = setup(<UploadPage />, { step: 'upload', master: null }, (url) =>
      url === '/v1/cv/upload' ? json({ upload: { id: 'up1', filename: 'cv.txt', kind: 'txt', status: 'queued', error: null, cv_version_id: null }, job_id: 'j' }, 202)
        : url === '/v1/cv/uploads/up1' ? uploadReply('reading', 'txt', 'cv.txt') : undefined)
    await userEvent.click(await screen.findByRole('button', { name: 'Paste the text' }))
    const box = screen.getByLabelText('Your CV as text')
    await userEvent.type(box, 'Too short.')
    await userEvent.click(screen.getByRole('button', { name: 'Read it' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('looks short for a CV')
    expect(calls.some((c) => c.url === '/v1/cv/upload')).toBe(false)
    await userEvent.clear(box)
    await userEvent.click(box)
    await userEvent.paste('Mara Quill, Backend Engineer. '.repeat(10))
    await userEvent.click(screen.getByRole('button', { name: 'Read it' }))
    await waitFor(() => expect(calls.some((c) => c.url === '/v1/cv/upload')).toBe(true))
    const file = (calls.find((c) => c.url === '/v1/cv/upload')!.body as FormData).get('file') as File
    expect(file.name).toBe('cv.txt')
    expect(file.type).toBe('text/plain')
    expect(await screen.findByText('Pasted text')).toBeInTheDocument()
  })

  it('shows the API message when pasted text is too short for it', async () => {
    setup(<UploadPage />, { step: 'upload', master: null }, (url) =>
      url === '/v1/cv/upload' ? json({ error: { code: 'too_short', field: 'file', message: 'That text is too short to be a CV.' } }, 400) : undefined)
    await userEvent.click(await screen.findByRole('button', { name: 'Paste the text' }))
    await userEvent.click(screen.getByLabelText('Your CV as text'))
    await userEvent.paste('x'.repeat(250))
    await userEvent.click(screen.getByRole('button', { name: 'Read it' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('That text is too short to be a CV.')
  })

  it('shows the failure and lets the user pick another file', async () => {
    sessionStorage.setItem('dl.onboarding.upload', 'up9')
    setup(<UploadPage />, { step: 'upload', master: null }, (url) =>
      url === '/v1/cv/uploads/up9' ? json({ upload: { id: 'up9', filename: 'cv.pdf', kind: 'pdf', status: 'failed', error: 'That PDF has no text.', cv_version_id: null } }) : undefined)
    expect(await screen.findByText(/We could not read that/)).toHaveTextContent('That PDF has no text.')
    expect(screen.getByLabelText('CV file')).toBeInTheDocument()
  })

  it('shows a saved CV at once after a reload and continues to Check', async () => {
    const calls = setup(<UploadPage />, { step: 'check', master: cv() })
    expect(await screen.findByText('Saved to your account')).toBeInTheDocument()
    expect(within(screen.getByRole('list', { name: 'What we read' })).getByText('Education')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Looks like me, continue' }))
    expect(await screen.findByText('Check route')).toBeInTheDocument()
    expect(patches(calls)).toEqual([])
  })

  it('sends an unverified user to verify-email', async () => {
    setup(<UploadPage />, { step: 'upload', master: null }, (url) => (url === '/v1/auth/me' ? json({ user: { ...me, email_verified: false } }) : undefined))
    expect(await screen.findByText('Verify route')).toBeInTheDocument()
  })

  it('does not let a finished account back in', async () => {
    setup(<UploadPage />, { step: 'done', master: cv() })
    expect(await screen.findByText('Home page')).toBeInTheDocument()
  })

  it('starts from scratch with a name', async () => {
    const calls = setup(<UploadPage />, { step: 'upload', master: null })
    await userEvent.click(await screen.findByRole('button', { name: 'Start from scratch' }))
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByText('Enter your name as it should appear on your CV.')).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Full name'), 'Mara Quill')
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByText('Check route')).toBeInTheDocument()
    const put = calls.find((c) => c.url === '/v1/cv/master' && c.method === 'PUT')!
    expect(JSON.parse(put.body as string).doc.header).toMatchObject({ name: 'Mara Quill', email: 'mara@example.com' })
    expect(patches(calls)).toEqual([{ onboarding_step: 'check' }])
  })
})

describe('CheckPage', () => {
  it('does not let someone skip ahead of the upload step', async () => {
    setup(<CheckPage />, { step: 'upload', master: null })
    expect(await screen.findByText('Upload route')).toBeInTheDocument()
  })

  it('shows loading, then an error with a retry', async () => {
    setup(<CheckPage />, { step: 'check', master: cv() }, (url) =>
      url === '/v1/cv/master' ? json({ error: { code: 'ai_unavailable', message: 'The service is busy.' } }, 503) : undefined)
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(await screen.findByText('That did not load')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('explains an empty state', async () => {
    setup(<CheckPage />, { step: 'check', master: null })
    expect(await screen.findByText('No CV yet')).toBeInTheDocument()
  })

  it('holds Continue until the fix is in, then moves on', async () => {
    const calls = setup(<CheckPage />, { step: 'check', master: cv() })
    expect(await screen.findByRole('heading', { name: 'Two quick things' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Fix the dates to continue' })).toBeDisabled()
    const card = screen.getByRole('region', { name: 'Needs your input' })
    expect(card).toHaveTextContent('When did you work at Kestrel?')
    await userEvent.type(within(card).getByLabelText('Started'), 'Jan 2016')
    await userEvent.type(within(card).getByLabelText('Ended'), 'Jun 2018')
    await userEvent.click(within(card).getByRole('button', { name: 'Save dates' }))
    expect(await screen.findByText('Kestrel, Jan 2016 to Jun 2018')).toBeInTheDocument()
    const put = calls.find((c) => c.method === 'PUT')!
    expect(JSON.parse(put.body as string).doc.experience[1]).toMatchObject({ start: 'Jan 2016', end: 'Jun 2018' })
    expect(screen.queryByRole('region', { name: 'Needs your input' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByText('Targets route')).toBeInTheDocument()
    expect(patches(calls)).toEqual([{ onboarding_step: 'targets' }])
  })

  it('asks for both dates before saving', async () => {
    const calls = setup(<CheckPage />, { step: 'check', master: cv() })
    const card = await screen.findByRole('region', { name: 'Needs your input' })
    await userEvent.type(within(card).getByLabelText('Started'), '2016')
    await userEvent.click(within(card).getByRole('button', { name: 'Save dates' }))
    expect(await within(card).findByRole('alert')).toHaveTextContent('Add both dates')
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })

  it('shows the API message when saving fails', async () => {
    setup(<CheckPage />, { step: 'check', master: cv() }, (url, init) =>
      url === '/v1/cv/master' && init?.method === 'PUT' ? json({ error: { code: 'invalid_input', message: 'experience[1].start must be at most 200 characters' } }, 422) : undefined)
    const card = await screen.findByRole('region', { name: 'Needs your input' })
    await userEvent.type(within(card).getByLabelText('Started'), '2016')
    await userEvent.type(within(card).getByLabelText('Ended'), '2018')
    await userEvent.click(within(card).getByRole('button', { name: 'Save dates' }))
    expect(await within(card).findByRole('alert')).toHaveTextContent('must be at most 200 characters')
  })

  it('never leaves anyone stuck: Fix later in Profile moves on', async () => {
    const calls = setup(<CheckPage />, { step: 'check', master: cv() })
    await userEvent.click(await screen.findByRole('button', { name: 'Fix later in Profile' }))
    expect(await screen.findByText('Targets route')).toBeInTheDocument()
    expect(patches(calls)).toEqual([{ onboarding_step: 'targets' }])
  })

  it('strengthens a bullet with the number the user gives, shown before saving and editable', async () => {
    const calls = setup(<CheckPage />, { step: 'check', master: cv({ issues: [] }) })
    expect(await screen.findByRole('heading', { name: 'One quick thing' })).toBeInTheDocument()
    expect(screen.getByText('1 of 2, optional')).toBeInTheDocument()
    const form = screen.getByRole('form', { name: 'Add a number to a bullet' })
    expect(within(form).getByText('Led the migration to Rust.')).toBeInTheDocument()
    await userEvent.click(within(form).getByRole('button', { name: 'Add it' }))
    expect(await within(form).findByRole('alert')).toHaveTextContent('Type the number first')
    await userEvent.type(within(form).getByLabelText('What number goes with this?'), 'cutting p99 latency by 40%')
    const merged = within(form).getByLabelText('Your bullet will read')
    expect(merged).toHaveValue('Led the migration to Rust, cutting p99 latency by 40%.')
    await userEvent.clear(merged)
    await userEvent.type(merged, 'Led the Rust migration, cutting p99 latency by 40%.')
    await userEvent.click(within(form).getByRole('button', { name: 'Add it' }))
    expect(await screen.findByText('2 of 2, optional')).toBeInTheDocument()
    const put = calls.find((c) => c.method === 'PUT')!
    expect(JSON.parse(put.body as string).doc.experience[0].bullets).toEqual(['Cut costs by 20%', 'Led the Rust migration, cutting p99 latency by 40%.'])
    await userEvent.click(screen.getByRole('button', { name: 'I do not know' }))
    expect(await screen.findByText(/One bullet now carries a number/)).toBeInTheDocument()
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1)
  })

  it('shows the whole CV on request on a phone', async () => {
    setup(<CheckPage />, { step: 'check', master: cv() })
    const toggle = await screen.findByRole('button', { name: 'See your whole CV' })
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const sheet = document.getElementById('whole-cv')!
    expect(within(sheet).getByText('Dates missing')).toBeInTheDocument()
    expect(within(sheet).getByText('Led the migration to Rust.')).toHaveTextContent('(being strengthened)')
  })
})

describe('TargetsPage', () => {
  it('picks roles from the CV, needs a work setting, and saves everything in one PATCH', async () => {
    const calls = setup(<TargetsPage />, { step: 'targets', master: cv() })
    const headline = await screen.findByRole('button', { name: 'Backend Engineer' })
    expect(headline).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Senior Engineer' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Engineer' })).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByText('Choose at least one.')).toBeInTheDocument()
    expect(patches(calls)).toEqual([])

    await userEvent.click(screen.getByRole('button', { name: 'Senior Engineer' }))
    await userEvent.click(screen.getByRole('button', { name: '+ Another' }))
    await userEvent.type(screen.getByLabelText('Another role'), 'Platform Engineer{Enter}')
    expect(screen.getByRole('button', { name: 'Platform Engineer' })).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(screen.getByRole('button', { name: 'Remote' }))
    await userEvent.click(screen.getByRole('button', { name: 'Hybrid' }))
    // No location saved yet, so the field is open.
    await userEvent.type(screen.getByLabelText('Where you are based'), 'Toronto, Canada')
    expect(screen.getByText(/CVs print on US Letter, the standard in Canada\./)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Done' }))
    await userEvent.click(screen.getByRole('button', { name: 'Remote anywhere' }))
    expect(screen.getByText(/Based in/)).toHaveTextContent('Based in Toronto, Canada. Open to remote roles anywhere.')
    await userEvent.click(screen.getByRole('button', { name: 'Use A4' }))
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByText('First job route')).toBeInTheDocument()
    expect(patches(calls)).toEqual([{
      target_roles: ['Backend Engineer', 'Platform Engineer'],
      work_settings: ['remote', 'hybrid'],
      location: 'Toronto, Canada',
      open_to: ['Remote anywhere'],
      paper_size: 'a4',
      onboarding_step: 'first_job',
    }])
  })

  it('restores saved choices and needs at least one role', async () => {
    const calls = setup(<TargetsPage />, { step: 'targets', master: cv(), profile: { target_roles: ['Staff Engineer'], work_settings: ['onsite'], location: 'Lagos, Nigeria', open_to: ['United Kingdom'] } })
    expect(await screen.findByRole('button', { name: 'Staff Engineer' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Backend Engineer' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'On-site' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'United Kingdom' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText(/Based in/)).toHaveTextContent('Based in Lagos, Nigeria. Open to United Kingdom.')
    expect(screen.getByText(/CVs print on A4, the standard in Nigeria\./)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Staff Engineer' }))
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByText('Choose at least one role.')).toBeInTheDocument()
    expect(patches(calls)).toEqual([])
  })

  it('puts an API field error next to its question', async () => {
    setup(<TargetsPage />, { step: 'targets', master: cv(), profile: { work_settings: ['remote'] } }, (url, init) =>
      url === '/v1/profile' && init?.method === 'PATCH' ? json({ error: { code: 'invalid_input', field: 'target_roles', message: 'target_roles has too many entries' } }, 422) : undefined)
    await userEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    expect(await screen.findByText('target_roles has too many entries')).toBeInTheDocument()
  })
})

const JD = 'We are hiring a backend engineer to build payment services in Go and Postgres. '.repeat(4)

describe('FirstJobPage', () => {
  it('shows the composer and the usage line', async () => {
    setup(<FirstJobPage />, { step: 'first_job', master: cv() })
    expect(await screen.findByRole('heading', { name: 'Now the good part. Which job?' })).toBeInTheDocument()
    expect(await screen.findByText('Uses 1 of your 10 applications this month')).toBeInTheDocument()
    expect(screen.getByText('Last step')).toBeInTheDocument()
  })

  it('checks the input before starting anything', async () => {
    const calls = setup(<FirstJobPage />, { step: 'first_job', master: cv() })
    await userEvent.click(await screen.findByRole('button', { name: 'Tailor my CV' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Paste a job link or the job description first.')
    await userEvent.type(screen.getByLabelText('Job link or description'), 'Backend role')
    await userEvent.click(screen.getByRole('button', { name: 'Tailor my CV' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('looks short for a job description')
    expect(calls.some((c) => c.url === '/v1/applications/start')).toBe(false)
  })

  it('starts tailoring, finishes onboarding and opens the running screen', async () => {
    const calls = setup(<FirstJobPage />, { step: 'first_job', master: cv() }, (url) =>
      url === '/v1/applications/start' ? json({ application_id: 'app1', job_id: 'job1', progress: [] }, 202) : undefined)
    await userEvent.click(await screen.findByLabelText('Job link or description'))
    await userEvent.paste(JD)
    await userEvent.click(screen.getByRole('button', { name: 'Tailor my CV' }))
    expect(await screen.findByText(/At \/applications\/app1\/running/)).toHaveTextContent('"jobId":"job1"')
    const start = calls.find((c) => c.url === '/v1/applications/start')!
    expect(JSON.parse(start.body as string)).toEqual({ jd_text: JD.trim(), research: true, letter: true })
    expect(patches(calls)).toEqual([{ onboarding_step: 'done' }])
  })

  it('sends a link as a link', async () => {
    const calls = setup(<FirstJobPage />, { step: 'first_job', master: cv() }, (url) =>
      url === '/v1/applications/start' ? json({ application_id: 'app1', job_id: 'job1', progress: [] }, 202) : undefined)
    await userEvent.type(await screen.findByLabelText('Job link or description'), 'https://jobs.example.com/123')
    await userEvent.click(screen.getByRole('button', { name: 'Tailor my CV' }))
    await screen.findByText(/At \/applications\/app1\/running/)
    expect(JSON.parse(calls.find((c) => c.url === '/v1/applications/start')!.body as string)).toEqual({ url: 'https://jobs.example.com/123', research: true, letter: true })
  })

  it('shows a start error and stays in onboarding', async () => {
    const calls = setup(<FirstJobPage />, { step: 'first_job', master: cv() }, (url) =>
      url === '/v1/applications/start' ? json({ error: { code: 'plan_limit_reached', message: 'You have used all 10 applications this month.' } }, 422) : undefined)
    await userEvent.click(await screen.findByLabelText('Job link or description'))
    await userEvent.paste(JD)
    await userEvent.click(screen.getByRole('button', { name: 'Tailor my CV' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('You have used all 10 applications this month.')
    expect(patches(calls)).toEqual([])
  })

  it('puts an unreadable link error on the field', async () => {
    setup(<FirstJobPage />, { step: 'first_job', master: cv() }, (url) =>
      url === '/v1/applications/start' ? json({ error: { code: 'link_unreadable', message: 'We could not read that page. Paste the text instead.' } }, 422) : undefined)
    await userEvent.type(await screen.findByLabelText('Job link or description'), 'https://jobs.example.com/123')
    await userEvent.click(screen.getByRole('button', { name: 'Tailor my CV' }))
    await waitFor(() => expect(screen.getByLabelText('Job link or description')).toHaveAttribute('aria-invalid', 'true'))
    expect(screen.getByText('We could not read that page. Paste the text instead.')).toBeInTheDocument()
  })

  it('goes Home without a job, marking onboarding done', async () => {
    const calls = setup(<FirstJobPage />, { step: 'first_job', master: cv() })
    await userEvent.click(await screen.findByRole('button', { name: 'No job in mind yet? Go to Home' }))
    expect(await screen.findByText('Home page')).toBeInTheDocument()
    expect(patches(calls)).toEqual([{ onboarding_step: 'done' }])
  })

  it('offers a retry when finishing fails', async () => {
    setup(<FirstJobPage />, { step: 'first_job', master: cv() }, (url, init) =>
      url === '/v1/profile' && init?.method === 'PATCH' ? json({ error: { code: 'http_500', message: 'Something broke.' } }, 500) : undefined)
    await userEvent.click(await screen.findByRole('button', { name: 'No job in mind yet? Go to Home' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Something broke.')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })
})
