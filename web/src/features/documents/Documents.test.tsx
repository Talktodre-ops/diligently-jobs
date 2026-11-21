import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLocation } from 'react-router'
import ApplicationPage from '../apply/ApplicationPage'
import DocumentsPage from './DocumentsPage'

// PDF.js needs a canvas and a worker; the drawn page is covered in the Edge e2e.
vi.mock('./PdfPages', async (real) => ({
  ...(await real<typeof import('./PdfPages')>()),
  PdfPages: ({ url }: { url: string }) => <div data-testid="pdf" data-url={url} />,
}))

const APP = 'app-1'
const link = (name: string) => `http://s3.test/f?response-content-disposition=${encodeURIComponent(`attachment; filename="${name}"`)}&sig=${Math.random()}`

const brief = {
  application: { id: APP, company: 'Halcyon Health', role: 'Senior Backend Engineer', status: 'draft', source_url: null, location: null, summary: null, created_at: '' },
  pipeline: { job_id: 'j', status: 'done', progress: [] },
  score: { before: 72, projected: 86, current: 78, rescored: null, decided: 1, pending: 2 },
  rewrites: { total: 2, pending: 1, accepted: 1, kept: 0, edited: 0 },
  summary: { proposed: false, status: 'pending' },
  gaps: { total: 0, missing: 0, partial: 0, unanswered: 0, top: [] },
  research: null,
  letter: { id: 'l1', tone: 'direct', words: 12 },
}
const research = {
  id: 'r1', application_id: APP, created_at: '2026-11-13T00:00:00Z',
  brief: {
    overview: 'Halcyon pays health claims on time. It runs on Kafka and Postgres.',
    products: ['Claims API'], culture: ['Reliability over speed'],
    recent_news: [{ text: 'Raised a Series B', source: 1 }],
    talking_points: [{ text: 'They publish incident reviews', source: 2 }],
    why_them: 'Claims that pay on time matter.',
  },
  sources: [
    { title: 'Series B announcement', url: 'https://halcyon.example/news/b', published: null },
    { title: 'Incident review template', url: 'https://halcyon.example/blog/ir', published: null },
  ],
}
const letter = (tone = 'direct', paragraphs = ['I build payment systems that stay up.', 'At Northfold I owned the payments service.']) => ({
  id: 'l1', application_id: APP, body: paragraphs.join('\n\n'), tone, r2_pdf_key: null, r2_docx_key: null, generated_at: '',
  doc: { candidate_name: 'Ada Okafor', greeting: 'Dear Hiring Team,', paragraphs, signoff: 'Kind regards,' },
})
const cv = {
  doc: {
    header: { name: 'Ada Okafor', title: 'Senior Backend Engineer', email: 'ada@example.com' },
    summary: 'Backend engineer.',
    experience: [{ role: 'Senior Backend Engineer', company: 'Northfold', start: '2021', end: 'Present', bullets: ['Owned the payments service on Kafka.', 'Mentored three engineers.'] }],
    education: [{ institution: 'University of Lagos', degree: 'B.Sc. Computer Science' }],
    skills: [{ label: 'Languages', items: ['Go', 'Rust'] }],
  },
  issues: [], paper_size: 'a4',
}
const rewrites = {
  summary: null,
  rewrites: [{ id: 'w1', bullet_id: 'E1.B1', section: 'Northfold', original: 'Owned payments.', rewrite: 'Owned the payments service on Kafka.', why: null, needs_number: false, status: 'accepted', final_text: null }],
  score: brief.score,
}
const files = (opts: { upToDate?: boolean; letter?: boolean } = {}) => ({
  cv: { pdf_url: link('Ada Okafor Halcyon Health CV.pdf'), docx_url: link('Ada Okafor Halcyon Health CV.docx'), rendered_at: '2026-11-13T00:00:00Z', up_to_date: opts.upToDate ?? true },
  letter: opts.letter === false ? { pdf_url: null, docx_url: null } : { pdf_url: link('Ada Okafor Halcyon Health Cover letter.pdf'), docx_url: link('Ada Okafor Halcyon Health Cover letter.docx') },
  expires_in_seconds: 600,
})

type Call = { url: string; method: string; body: unknown }
type Handler = (url: string, method: string, body: unknown) => unknown

const settingsProfile = (over: object) => ({
  full_name: 'Ada Okafor', headline: null, location: 'Lagos', target_roles: [], work_settings: [], paper_size: 'a4', theme: 'system',
  notifications: { follow_ups: true, weekly_summary: true, running_low: true, product_news: false },
  reminders: { follow_up_days: 7, send_hour: 9, time_zone: 'Africa/Lagos', skip_weekends: true },
  writing: { spelling: null, letter_tone: 'direct' }, onboarding_step: 'done', updated_at: '', ...over,
})
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
const notFound = () => json({ error: { code: 'not_found', message: 'Not found' } }, 404)

function Where() {
  const l = useLocation()
  return <div data-testid="where">{l.pathname + l.search}</div>
}

function setup(ui: ReactElement, path: string, handler: Handler) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(init.body as string) : undefined
    calls.push({ url, method, body })
    const out = handler(url, method, body)
    if (out instanceof Response) return out
    if (out !== undefined) return json(out)
    return notFound()
  }))
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/applications/:id" element={<>{ui}<Where /></>} />
          <Route path="/documents" element={ui} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return calls
}

const base: Handler = (url) => {
  if (url === `/v1/applications/${APP}/brief`) return brief
  if (url === `/v1/applications/${APP}/cv`) return cv
  if (url === `/v1/applications/${APP}/rewrites`) return rewrites
  if (url === `/v1/applications/${APP}/gaps`) return { gaps: [] }
  return undefined
}

let clicked: string[]
beforeEach(() => {
  clicked = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this.href) })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Company tab', () => {
  it('shows loading, then the overview, talking points and sources', async () => {
    setup(<ApplicationPage />, `/applications/${APP}?tab=company`, (u, m, b) => base(u, m, b) ?? (u.endsWith('/research') ? research : undefined))
    expect(await screen.findByRole('heading', { name: 'Halcyon pays health claims on time.' })).toBeInTheDocument()
    expect(screen.getByText('It runs on Kafka and Postgres.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Raised a Series B/ })).toHaveAttribute('href', 'https://halcyon.example/news/b')

    expect(screen.getByRole('tab', { name: 'Company' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('They publish incident reviews')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Source: Incident review template/ })).toHaveAttribute('target', '_blank')
    expect(within(screen.getByRole('region', { name: 'Sources' })).getAllByRole('link')).toHaveLength(2)
  })

  it('offers to research when there is none yet', async () => {
    let made = false
    const calls = setup(<ApplicationPage />, `/applications/${APP}?tab=company`, (u, m, b) => {
      if (u.endsWith('/research/refresh') && m === 'POST') { made = true; return research }
      if (u.endsWith('/research')) return made ? research : notFound()
      return base(u, m, b)
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Research Halcyon Health' }))
    expect(await screen.findByRole('heading', { name: 'Halcyon pays health claims on time.' })).toBeInTheDocument()
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/research/refresh'))).toBe(true)
  })

  it('shows the error with a retry', async () => {
    setup(<ApplicationPage />, `/applications/${APP}?tab=company`, (u, m, b) =>
      u.endsWith('/research') ? json({ error: { code: 'internal', message: 'Something broke.' } }, 500) : base(u, m, b))
    expect(await screen.findByRole('alert')).toHaveTextContent('Something broke.')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })
})

describe('Letter tab', () => {
  it('opens on the letter as LaTeX set it, with Edit for the text', async () => {
    setup(<ApplicationPage />, `/applications/${APP}?tab=letter`, (u, m, b) => {
      if (u.endsWith('/cover-letters')) return letter()
      if (u.endsWith('/files')) return files()
      return base(u, m, b)
    })
    const page = await screen.findByTestId('pdf')
    expect(decodeURIComponent(page.dataset.url!)).toContain('Cover letter.pdf')
    expect(screen.getByText(/Exactly what the recruiter gets/)).toBeInTheDocument()
    expect(screen.queryByText('Dear Hiring Team,')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(await screen.findByText('Dear Hiring Team,')).toBeInTheDocument()
    expect(screen.getByTestId('where')).toHaveTextContent(`/applications/${APP}?tab=letter&view=edit`)
  })

  it('sets a letter without a file in type before showing it', async () => {
    let rendered = false
    const calls = setup(<ApplicationPage />, `/applications/${APP}?tab=letter`, (u, m, b) => {
      if (u.endsWith('/cover-letters')) return letter()
      if (u.endsWith('/files')) return rendered ? files() : files({ letter: false })
      if (u.endsWith('/render')) { rendered = true; return { cv_version_id: 'v', cv_job_id: 'cj', letter_job_id: 'lj' } }
      if (u === '/v1/jobs/cj' || u === '/v1/jobs/lj') return { id: u.split('/').pop(), kind: 'render', status: 'done', result: null, attempts: 1, max_attempts: 3, progress: null }
      return base(u, m, b)
    })
    const pdf = await screen.findByTestId('pdf')
    expect(decodeURIComponent(pdf.dataset.url!)).toContain('Cover letter.pdf')
    expect(calls.find((c) => c.url.endsWith('/render'))?.body).toEqual({ include_letter: true })
  })

  it('rewrites in another tone through the API', async () => {
    let current = letter()
    const calls = setup(<ApplicationPage />, `/applications/${APP}?tab=letter&view=edit`, (u, m, b) => {
      if (u.endsWith('/cover-letters/regenerate')) { current = letter((b as { tone: string }).tone, ['A warm opening.', 'A warm close.']); return current }
      if (u.endsWith('/cover-letters')) return current
      return base(u, m, b)
    })
    expect(await screen.findByText('Dear Hiring Team,')).toBeInTheDocument()
    expect(screen.getByText('14 words')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Warm' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Warm' })).toHaveAttribute('aria-pressed', 'true'))
    expect(screen.getByText('A warm opening.')).toBeInTheDocument()
    expect(calls.find((c) => c.url.endsWith('/regenerate'))?.body).toEqual({ tone: 'warm' })
  })

  it('saves an edited paragraph with the others untouched', async () => {
    const calls = setup(<ApplicationPage />, `/applications/${APP}?tab=letter&view=edit`, (u, m, b) => {
      if (u === '/v1/cover-letters/l1' && m === 'PATCH') return letter('direct', (b as { paragraphs: string[] }).paragraphs)
      if (u.endsWith('/cover-letters')) return letter()
      return base(u, m, b)
    })
    await userEvent.click(await screen.findByRole('button', { name: /I build payment systems/ }))
    const box = screen.getByLabelText('Paragraph 1')
    await userEvent.clear(box)
    await userEvent.type(box, 'I keep payment systems up.')
    await userEvent.click(screen.getByRole('button', { name: 'Save paragraph' }))
    expect(await screen.findByRole('button', { name: /I keep payment systems up\./ })).toBeInTheDocument()
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ paragraphs: ['I keep payment systems up.', 'At Northfold I owned the payments service.'] })
  })

  it('copies the whole letter', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    setup(<ApplicationPage />, `/applications/${APP}?tab=letter&view=edit`, (u, m, b) => (u.endsWith('/cover-letters') ? letter() : base(u, m, b)))
    await userEvent.click(await screen.findByRole('button', { name: 'Copy' }))
    expect(await screen.findByText('Copied to clipboard')).toBeInTheDocument()
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Dear Hiring Team,\n\nI build payment systems that stay up.'))
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Kind regards,\nAda Okafor'))
  })

  it('offers to write one when there is no letter', async () => {
    setup(<ApplicationPage />, `/applications/${APP}?tab=letter`, base)
    expect(await screen.findByText('No letter yet')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Write a letter' })).toBeInTheDocument()
  })

  it('starts the first letter in the tone chosen in Settings', async () => {
    const calls = setup(<ApplicationPage />, `/applications/${APP}?tab=letter`, (u, m, b) =>
      u === '/v1/profile' ? { profile: settingsProfile({ writing: { spelling: null, letter_tone: 'formal' } }) } : base(u, m, b))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Formal' })).toHaveAttribute('aria-pressed', 'true'))
    expect(screen.getByRole('button', { name: 'Direct' })).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(screen.getByRole('button', { name: 'Write a letter' }))
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/regenerate'))?.body).toEqual({ tone: 'formal' }))
  })

  it('lets the first letter start in another tone', async () => {
    const calls = setup(<ApplicationPage />, `/applications/${APP}?tab=letter`, (u, m, b) =>
      u === '/v1/profile' ? { profile: settingsProfile({ writing: { spelling: null, letter_tone: 'formal' } }) } : base(u, m, b))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Formal' })).toHaveAttribute('aria-pressed', 'true'))
    await userEvent.click(screen.getByRole('button', { name: 'Warm' }))
    await userEvent.click(screen.getByRole('button', { name: 'Write a letter' }))
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/regenerate'))?.body).toEqual({ tone: 'warm' }))
  })
})

describe('Download sheet', () => {
  const withLetter: Handler = (u, m, b) => {
    if (u.endsWith('/cover-letters')) return letter()
    if (u.endsWith('/files')) return files()
    return base(u, m, b)
  }
  const appliedReply = (due: string) => ({ application_id: APP, stage: 'applied', reminder: { id: 'rem', application_id: APP, due_at: due, status: 'scheduled', sent_at: null } })

  it('downloads both files, then marks applied and moves the reminder', async () => {
    const calls = setup(<ApplicationPage />, `/applications/${APP}?download=1`, (u, m, b) => {
      if (u.endsWith('/applied')) return appliedReply('2026-11-20T09:00:00Z')
      if (u === '/v1/reminders/rem/snooze') return { reminder: { id: 'rem', application_id: APP, due_at: '2026-11-23T09:00:00Z', status: 'scheduled', sent_at: null } }
      return withLetter(u, m, b)
    })
    expect(await screen.findByRole('dialog', { name: 'Download your files' })).toBeInTheDocument()
    expect(screen.getByText('For Halcyon Health, Senior Backend Engineer')).toBeInTheDocument()
    const list = await screen.findByRole('list', { name: 'Files' })
    expect(within(list).getByText('Ada Okafor Halcyon Health CV.pdf')).toBeInTheDocument()
    expect(within(list).getByText('Ada Okafor Halcyon Health Cover letter.pdf')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('radio', { name: /DOCX/ }))
    expect(within(list).getByText('Ada Okafor Halcyon Health CV.docx')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('radio', { name: /PDF/ }))

    await userEvent.click(screen.getByRole('button', { name: 'Download both' }))
    const ask = await screen.findByRole('region', { name: 'Did you apply?' })
    await waitFor(() => expect(clicked).toHaveLength(2))
    expect(calls.find((c) => c.url === '/v1/events')?.body).toEqual({
      kind: 'files_downloaded', application_id: APP, payload: { format: 'pdf', files: 'cv+letter', via: 'downloaded' },
    })
    await userEvent.click(within(ask).getByRole('button', { name: 'Yes, I applied' }))
    expect(await screen.findByRole('heading', { name: 'Applied.' })).toBeInTheDocument()
    expect(screen.getByText(/with a match of 78/)).toBeInTheDocument()
    expect(calls.find((c) => c.url.endsWith('/applied'))?.body).toEqual({ reminder_days: 7 })

    await userEvent.click(screen.getByRole('button', { name: '10 days' }))
    expect(await screen.findByText('We will nudge you on Mon 23 Nov with a draft ready.')).toBeInTheDocument()
    expect(calls.find((c) => c.url.endsWith('/snooze'))?.body).toEqual({ days: 10 })
  })

  it('downloads the CV or the letter on its own', async () => {
    setup(<ApplicationPage />, `/applications/${APP}?download=1`, withLetter)
    await screen.findByRole('list', { name: 'Files' })
    await userEvent.click(screen.getByRole('button', { name: 'Download the cover letter as PDF' }))
    await waitFor(() => expect(clicked).toHaveLength(1))
    expect(decodeURIComponent(clicked[0]!)).toContain('Cover letter.pdf')
    await userEvent.click(screen.getByRole('radio', { name: /DOCX/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Download the CV as DOCX' }))
    await waitFor(() => expect(clicked).toHaveLength(2))
    expect(decodeURIComponent(clicked[1]!)).toContain('CV.docx')
    expect(screen.getByRole('region', { name: 'Did you apply?' })).toBeInTheDocument()
  })

  it('lets "Not yet" put the question away', async () => {
    setup(<ApplicationPage />, `/applications/${APP}?download=1`, withLetter)
    await screen.findByRole('list', { name: 'Files' })
    await userEvent.click(screen.getByRole('button', { name: 'Download both' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Not yet' }))
    expect(screen.queryByRole('region', { name: 'Did you apply?' })).not.toBeInTheDocument()
    expect(screen.getByText(/Attach them wherever you apply/)).toBeInTheDocument()
  })

  it('keeps its place when the window crosses the desktop width', async () => {
    let wide = true
    const listeners = new Set<() => void>()
    vi.stubGlobal('matchMedia', (q: string) => ({
      get matches() { return wide }, media: q,
      addEventListener: (_: string, f: () => void) => listeners.add(f),
      removeEventListener: (_: string, f: () => void) => listeners.delete(f),
    }))
    setup(<ApplicationPage />, `/applications/${APP}?download=1`, withLetter)
    await screen.findByRole('list', { name: 'Files' })
    await userEvent.click(screen.getByRole('button', { name: 'Download both' }))
    await screen.findByRole('region', { name: 'Did you apply?' })
    act(() => { wide = false; listeners.forEach((f) => f()) })
    expect(screen.getByRole('region', { name: 'Did you apply?' })).toBeInTheDocument()
    act(() => { wide = true; listeners.forEach((f) => f()) })
    expect(screen.getByRole('region', { name: 'Did you apply?' })).toBeInTheDocument()
  })

  it('preselects the follow-up days from Settings and offers 14', async () => {
    const calls = setup(<ApplicationPage />, `/applications/${APP}?download=1`, (u, m, b) => {
      if (u === '/v1/profile') return { profile: settingsProfile({ reminders: { follow_up_days: 14, send_hour: 9, time_zone: 'Africa/Lagos', skip_weekends: true } }) }
      if (u.endsWith('/applied')) return appliedReply('2026-12-01T09:00:00Z')
      return withLetter(u, m, b)
    })
    await screen.findByRole('list', { name: 'Files' })
    await waitFor(() => expect(calls.some((c) => c.url === '/v1/profile')).toBe(true))
    await userEvent.click(screen.getByRole('button', { name: 'Download both' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Yes, I applied' }))
    expect(await screen.findByRole('heading', { name: 'Applied.' })).toBeInTheDocument()
    expect(calls.find((c) => c.url.endsWith('/applied'))?.body).toEqual({ reminder_days: 14 })
    const group = screen.getByRole('group', { name: 'Remind me to follow up in' })
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['5 days', '7 days', '10 days', '14 days'])
    expect(within(group).getByRole('button', { name: '14 days' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('says how many changes are in the CV and links to the ones not looked at', async () => {
    setup(<ApplicationPage />, `/applications/${APP}?download=1`, (u, m, b) => (u.endsWith('/files') ? files() : base(u, m, b)))
    expect(await screen.findByText(/Your CV has 1 change for this job\. You have not looked at 2\./)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Look them over' }))
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(`/applications/${APP}?change=next`))
  })

  it('says the CV is unchanged when every original was kept', async () => {
    setup(<ApplicationPage />, `/applications/${APP}?download=1`, (u, m, b) =>
      u === `/v1/applications/${APP}/brief` ? { ...brief, score: { ...brief.score, decided: 0, pending: 0 } } : u.endsWith('/files') ? files() : base(u, m, b))
    const sheet = await screen.findByRole('dialog', { name: 'Download your files' })
    expect(within(sheet).getByText('Your CV is as you wrote it.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Look them over' })).not.toBeInTheDocument()
  })

  it('names the employer only when the posting did', async () => {
    setup(<ApplicationPage />, `/applications/${APP}?download=1`, (u, m, b) =>
      u === `/v1/applications/${APP}/brief` ? { ...brief, application: { ...brief.application, company: null } } : u.endsWith('/files') ? files() : base(u, m, b))
    const sheet = await screen.findByRole('dialog', { name: 'Download your files' })
    expect(within(sheet).queryByText(/^For .*, Senior Backend Engineer/)).not.toBeInTheDocument()
    expect(within(sheet).queryByText(/New job/)).not.toBeInTheDocument()
  })

  it('downloads the CV alone when there is no letter', async () => {
    setup(<ApplicationPage />, `/applications/${APP}?download=1`, (u, m, b) => (u.endsWith('/files') ? files({ letter: false }) : base(u, m, b)))
    expect(await screen.findByText(/No cover letter for this job yet/)).toBeInTheDocument()
    const list = await screen.findByRole('list', { name: 'Files' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Download CV' })).toBeEnabled()
  })

  it('still opens from an address made before Send became Download', async () => {
    setup(<ApplicationPage />, `/applications/${APP}?send=1`, withLetter)
    expect(await screen.findByRole('dialog', { name: 'Download your files' })).toBeInTheDocument()
  })
})

describe('DocumentsPage', () => {
  const docs = [
    { kind: 'cv', application_id: APP, company: 'Halcyon Health', role: 'Senior Backend Engineer', score: 86, formats: ['pdf', 'docx'], updated_at: new Date().toISOString() },
    { kind: 'letter', id: 'l1', application_id: APP, company: 'Halcyon Health', tone: 'direct', words: 248, updated_at: new Date().toISOString() },
  ]

  it('lists the master CV and the documents, and filters by kind', async () => {
    const calls = setup(<DocumentsPage />, '/documents', (u) => {
      if (u === '/v1/cv/master') return { cv: { id: 'm', doc: { header: { name: 'Ada Okafor' } }, issues: [], updated_at: new Date().toISOString() } }
      if (u === '/v1/documents?kind=all') return { documents: docs }
      if (u === '/v1/documents?kind=letter') return { documents: [docs[1]] }
      return undefined
    })
    expect(await screen.findByRole('link', { name: /CV · Halcyon Health.*match 86 · PDF, DOCX/ })).toHaveAttribute('href', `/applications/${APP}`)
    expect(screen.getByRole('link', { name: /Letter · Halcyon Health.*Direct tone · 248 words/ })).toHaveAttribute('href', `/applications/${APP}?tab=letter`)
    expect(await screen.findByRole('link', { name: /Master CV.*Ada Okafor/ })).toHaveAttribute('href', '/profile')

    await userEvent.click(screen.getByRole('tab', { name: 'Letters' }))
    await waitFor(() => expect(screen.queryByRole('link', { name: /^CV ·/ })).not.toBeInTheDocument())
    expect(calls.some((c) => c.url === '/v1/documents?kind=letter')).toBe(true)
  })

  it('downloads a CV from the list', async () => {
    setup(<DocumentsPage />, '/documents', (u, m, b) => {
      if (u === '/v1/documents?kind=all') return { documents: docs }
      if (u.endsWith('/files')) return files()
      return base(u, m, b)
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Download CV · Halcyon Health' }))
    await waitFor(() => expect(clicked).toHaveLength(1))
    expect(decodeURIComponent(clicked[0]!)).toContain('Halcyon Health CV.pdf')
  })

  it('shows an empty state and an error state', async () => {
    setup(<DocumentsPage />, '/documents', (u) => (u.startsWith('/v1/documents') ? { documents: [] } : undefined))
    expect(await screen.findByText('No documents yet')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Add a job' })).toHaveAttribute('href', '/new')
  })

  it('shows the error with a retry', async () => {
    setup(<DocumentsPage />, '/documents', (u) => (u.startsWith('/v1/documents') ? json({ error: { code: 'internal', message: 'List failed.' } }, 500) : undefined))
    expect(await screen.findByRole('alert')).toHaveTextContent('List failed.')
  })
})
