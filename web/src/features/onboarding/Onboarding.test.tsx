import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cvCounts, fileProblem, type MasterCv } from './api'
import CheckPage from './CheckPage'
import TargetsPage from './TargetsPage'
import UploadPage from './UploadPage'

const me = { id: 'u', email: 'mara@example.com', email_verified: true, plan: 'free', created_at: '' }
const profile = (step: string, extra = {}) => ({
  full_name: null, headline: null, location: null, target_roles: [], work_settings: [], paper_size: 'a4', theme: 'system',
  notifications: { follow_ups: true, interview_prep: true, product_news: false }, onboarding_step: step, updated_at: '', ...extra,
})
const cv = (over: Partial<MasterCv> = {}): MasterCv => ({
  id: 'c',
  doc: {
    header: { name: 'Mara Quill', title: 'Backend Engineer', email: 'mara@example.com' },
    experience: [
      { role: 'Senior Engineer', company: 'Larkspur', start: '2021', end: 'Present', bullets: ['a', 'b'] },
      { role: 'Engineer', company: 'Kestrel', start: '', end: '', bullets: ['c'] },
    ],
    education: [], skills: [{ label: 'Languages', items: ['Go', 'Rust'] }], projects: [],
  },
  issues: [{ path: 'experience[1]', message: 'Dates are missing for Kestrel.' }],
  updated_at: '',
  ...over,
})
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })

type Call = { url: string; method: string; body?: BodyInit | null }
function setup(ui: React.ReactElement, state: { step: string; master: MasterCv | null; profile?: object }, extra?: (url: string, init?: RequestInit) => Response | undefined) {
  const calls: Call[] = []
  const live = { ...state }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: init?.body })
    const hit = extra?.(url, init)
    if (hit) return hit
    if (url === '/v1/auth/me') return json({ user: me })
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
      <MemoryRouter initialEntries={['/x']}>
        <Routes>
          <Route path="/x" element={ui} />
          <Route path="/" element={<div>Home page</div>} />
          <Route path="/onboarding/upload" element={<div>Upload route</div>} />
          <Route path="/onboarding/check" element={<div>Check route</div>} />
          <Route path="/onboarding/targets" element={<div>Targets route</div>} />
          <Route path="/verify-email" element={<div>Verify route</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

describe('helpers', () => {
  it('checks type and size like the API', () => {
    expect(fileProblem(new File(['x'], 'cv.txt'))).toMatch(/PDF or DOCX/)
    expect(fileProblem(new File([], 'cv.pdf'))).toMatch(/empty/)
    expect(fileProblem(new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'cv.PDF'))).toMatch(/5 MB/)
    expect(fileProblem(new File(['x'], 'cv.docx'))).toBeNull()
  })
  it('counts roles, bullets and skills', () => {
    expect(cvCounts(cv().doc)).toEqual({ roles: 2, bullets: 3, skills: 2 })
  })
})

describe('UploadPage', () => {
  it('refuses a wrong file type without calling the API', async () => {
    const calls = setup(<UploadPage />, { step: 'upload', master: null })
    const input = await screen.findByLabelText('CV file')
    await userEvent.upload(input, new File(['x'], 'notes.txt', { type: 'text/plain' }), { applyAccept: false })
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose a PDF or DOCX file.')
    expect(calls.some((c) => c.url === '/v1/cv/upload')).toBe(false)
  })

  it('uploads as multipart, polls until done, then offers Continue', async () => {
    let polls = 0
    const calls = setup(<UploadPage />, { step: 'upload', master: null }, (url, init) => {
      if (url === '/v1/cv/upload') return json({ upload: { id: 'up1', filename: 'cv.pdf', kind: 'pdf', status: 'queued', error: null, cv_version_id: null }, job_id: 'j' }, 202)
      if (url === '/v1/cv/uploads/up1') {
        polls++
        const done = polls > 1
        return json({ upload: { id: 'up1', filename: 'cv.pdf', kind: 'pdf', status: done ? 'done' : 'reading', error: null, cv_version_id: done ? 'v' : null } })
      }
      void init
      return undefined
    })
    await userEvent.upload(await screen.findByLabelText('CV file'), new File(['%PDF'], 'cv.pdf', { type: 'application/pdf' }))
    const sent = calls.find((c) => c.url === '/v1/cv/upload')!
    expect(sent.body).toBeInstanceOf(FormData)
    expect((sent.body as FormData).get('file')).toBeInstanceOf(File)
    expect(await screen.findByText(/Reading it|Waiting for a reader/)).toBeInTheDocument()
  })

  it('shows the failure and lets the user pick another file', async () => {
    sessionStorage.setItem('dl.onboarding.upload', 'up9')
    setup(<UploadPage />, { step: 'upload', master: null }, (url) =>
      url === '/v1/cv/uploads/up9' ? json({ upload: { id: 'up9', filename: 'cv.pdf', kind: 'pdf', status: 'failed', error: 'That PDF has no text.', cv_version_id: null } }) : undefined)
    expect(await screen.findByText(/We could not read that file/)).toHaveTextContent('That PDF has no text.')
    expect(screen.getByLabelText('CV file')).toBeInTheDocument()
  })

  it('shows the saved CV after a reload and continues to Check', async () => {
    setup(<UploadPage />, { step: 'check', master: cv() })
    expect(await screen.findByText('Saved to your account')).toBeInTheDocument()
    expect(screen.getByText('1 thing to check on the next screen')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByText('Check route')).toBeInTheDocument()
  })

  it('sends an unverified user to verify-email', async () => {
    setup(<UploadPage />, { step: 'upload', master: null }, (url) => (url === '/v1/auth/me' ? json({ user: { ...me, email_verified: false } }) : undefined))
    expect(await screen.findByText('Verify route')).toBeInTheDocument()
  })

  it('does not let a finished account back in', async () => {
    setup(<UploadPage />, { step: 'done', master: cv() })
    expect(await screen.findByText('Home page')).toBeInTheDocument()
  })

  it('builds a CV by hand from a name', async () => {
    const calls = setup(<UploadPage />, { step: 'upload', master: null })
    await userEvent.click(await screen.findByRole('button', { name: 'Build it by hand instead' }))
    await userEvent.type(screen.getByLabelText('Full name'), 'Mara Quill')
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByText('Check route')).toBeInTheDocument()
    const put = calls.find((c) => c.url === '/v1/cv/master' && c.method === 'PUT')!
    expect(JSON.parse(put.body as string).doc.header).toMatchObject({ name: 'Mara Quill', email: 'mara@example.com' })
    expect(calls.some((c) => c.method === 'PATCH' && String(c.body).includes('"check"'))).toBe(true)
  })
})

describe('CheckPage', () => {
  it('does not let someone skip ahead of the upload step', async () => {
    setup(<CheckPage />, { step: 'upload', master: null })
    expect(await screen.findByText('Upload route')).toBeInTheDocument()
  })

  it('shows flagged fields, saves the fix, and moves on', async () => {
    const calls = setup(<CheckPage />, { step: 'check', master: cv() })
    const card = await screen.findByRole('region', { name: 'Needs your input' })
    expect(card).toHaveTextContent('Dates are missing for Kestrel.')
    await userEvent.type(within(card).getByLabelText('Started'), 'Jan 2016')
    await userEvent.type(within(card).getByLabelText('Ended'), 'Jun 2018')
    await userEvent.click(within(card).getByRole('button', { name: 'Save dates' }))
    expect(await screen.findByText('Saved. Everything checks out.')).toBeInTheDocument()
    const put = calls.find((c) => c.method === 'PUT')!
    expect(JSON.parse(put.body as string).doc.experience[1]).toMatchObject({ start: 'Jan 2016', end: 'Jun 2018' })
    expect(screen.queryByRole('region', { name: 'Needs your input' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Looks right' }))
    expect(await screen.findByText('Targets route')).toBeInTheDocument()
    expect(calls.some((c) => c.method === 'PATCH' && String(c.body).includes('"targets"'))).toBe(true)
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

  it('expands a section to show the parsed CV', async () => {
    setup(<CheckPage />, { step: 'check', master: cv() })
    const skills = await screen.findByRole('button', { name: /Skills/ })
    expect(skills).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(skills)
    expect(screen.getByText('Rust')).toBeInTheDocument()
  })

  it('explains an empty state', async () => {
    setup(<CheckPage />, { step: 'check', master: null })
    expect(await screen.findByText('No CV yet')).toBeInTheDocument()
  })
})

describe('TargetsPage', () => {
  it('needs a role, then saves everything and finishes', async () => {
    const calls = setup(<TargetsPage />, { step: 'targets', master: cv() })
    await userEvent.click(await screen.findByRole('button', { name: 'Finish setup' }))
    expect(await screen.findByText('Add at least one role you are looking for.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '+ Backend Engineer' }))
    await userEvent.click(screen.getByRole('button', { name: 'Remote' }))
    await userEvent.click(screen.getByRole('button', { name: 'Hybrid' }))
    await userEvent.type(screen.getByLabelText('Where you are'), 'London, UK')
    await userEvent.click(screen.getByRole('button', { name: /US Letter/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Finish setup' }))
    await waitFor(() => expect(screen.getByText('Home page')).toBeInTheDocument())
    const patch = calls.find((c) => c.method === 'PATCH')!
    expect(JSON.parse(patch.body as string)).toEqual({
      target_roles: ['Backend Engineer'], work_settings: ['remote', 'hybrid'], location: 'London, UK', paper_size: 'letter', onboarding_step: 'done',
    })
  })

  it('counts a typed role that was not added yet, and restores saved values', async () => {
    const calls = setup(<TargetsPage />, { step: 'targets', master: cv(), profile: { target_roles: ['Staff Engineer'], location: 'Lagos' } })
    expect(await screen.findByLabelText('Where you are')).toHaveValue('Lagos')
    expect(screen.getByRole('button', { name: 'Remove Staff Engineer' })).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Add a role'), 'Data Engineer')
    await userEvent.click(screen.getByRole('button', { name: 'Finish setup' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true))
    expect(JSON.parse(calls.find((c) => c.method === 'PATCH')!.body as string).target_roles).toEqual(['Staff Engineer', 'Data Engineer'])
  })
})
