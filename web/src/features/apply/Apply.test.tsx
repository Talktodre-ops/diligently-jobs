import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import NewJobPage from './NewJobPage'
import { APP, apiError, json, renderRoute, type Call } from './testing'

afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

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
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(`/applications/${APP}`))
    expect(calls[0]!.body).toEqual({ jd_text: JD.trim(), research: true, letter: false })
  })

  it('explains a missing master CV and links to the upload', async () => {
    open((c) => (is(c, 'POST', '/v1/applications/start') ? apiError(422, 'no_master_cv', 'Upload your CV first.') : undefined))
    const u = userEvent.setup()
    await u.click(screen.getByLabelText('Job description'))
    await u.paste(JD)
    await u.click(screen.getByRole('button', { name: 'Tailor my CV' }))
    expect(await screen.findByText(/Add your CV first\..*we keep this job for you/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Add your CV' })).toHaveAttribute('href', '/onboarding/upload?then=/new')
    expect(sessionStorage.getItem('diligently:job-draft')).toBe(JD)
  })

  it('brings back a job pasted before there was a CV, and forgets it once started', async () => {
    sessionStorage.setItem('diligently:job-draft', JD)
    const calls = open((c) => (is(c, 'POST', '/v1/applications/start') ? json({ application_id: APP, job_id: 'j1', progress: [] }, 202) : undefined))
    expect(screen.getByLabelText('Job description')).toHaveValue(JD)
    await userEvent.click(screen.getByRole('button', { name: 'Tailor my CV' }))
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(`/applications/${APP}`))
    expect(calls[0]!.body).toMatchObject({ jd_text: JD.trim() })
    expect(sessionStorage.getItem('diligently:job-draft')).toBeNull()
  })

  it('brings back a pasted link on the link tab', () => {
    sessionStorage.setItem('diligently:job-draft', 'https://jobs.example.com/7')
    open()
    expect(screen.getByRole('tab', { name: 'Job link' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByLabelText('Link to the job')).toHaveValue('https://jobs.example.com/7')
  })

  it('opens a job shared from another app on the link tab', () => {
    renderRoute(<NewJobPage />, {
      path: `/new?title=Senior%20Engineer&text=${encodeURIComponent('Check out this job: https://www.linkedin.com/jobs/view/42.')}`,
      pattern: '/new', api: () => undefined,
    })
    expect(screen.getByRole('tab', { name: 'Job link' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByLabelText('Link to the job')).toHaveValue('https://www.linkedin.com/jobs/view/42')
  })

  it('takes shared text without a link as the description', () => {
    renderRoute(<NewJobPage />, { path: `/new?text=${encodeURIComponent(JD)}`, pattern: '/new', api: () => undefined })
    expect(screen.getByLabelText('Job description')).toHaveValue(JD.trim())
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
