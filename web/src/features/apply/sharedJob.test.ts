import { describe, expect, it } from 'vitest'
import { sharedJob } from './sharedJob'

const p = (q: Record<string, string>) => new URLSearchParams(q)

describe('sharedJob', () => {
  it('prefers the url field', () => {
    expect(sharedJob(p({ url: 'https://jobs.example.com/1', text: 'https://other.example.com' }))).toBe('https://jobs.example.com/1')
  })
  it('finds a link inside the shared text and drops trailing punctuation', () => {
    expect(sharedJob(p({ text: 'Look (https://jobs.example.com/2).' }))).toBe('https://jobs.example.com/2')
  })
  it('falls back to the title and text as a description', () => {
    expect(sharedJob(p({ title: 'Backend Engineer', text: 'Own our ledger.' }))).toBe('Backend Engineer\n\nOwn our ledger.')
  })
  it('ignores a url field that is not a link', () => {
    expect(sharedJob(p({ url: 'javascript:alert(1)' }))).toBeNull()
  })
  it('returns nothing when nothing was shared', () => {
    expect(sharedJob(p({}))).toBeNull()
  })
})
