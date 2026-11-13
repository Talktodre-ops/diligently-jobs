import { describe, expect, it } from 'vitest'
import type { Rewrites } from '../apply/api'
import { dateRange, fileNameFromUrl, firstSentence, hostOf, shownScore } from './format'
import { changedTexts, containsAtWordBoundary, countChanged } from './highlights'

describe('fileNameFromUrl', () => {
  it('reads the name the API signed into the link', () => {
    const url = 'http://localhost:8339/b/u/1/cvs/2.pdf?x-id=GetObject&response-content-disposition=attachment%3B%20filename%3D%22Ada%20Okafor%20Paystack%20CV.pdf%22&X-Amz-Expires=600'
    expect(fileNameFromUrl(url)).toBe('Ada Okafor Paystack CV.pdf')
  })
  it('returns null without a link or a name', () => {
    expect(fileNameFromUrl(null)).toBeNull()
    expect(fileNameFromUrl('http://x/y.pdf')).toBeNull()
    expect(fileNameFromUrl('not a url')).toBeNull()
  })
})

describe('format helpers', () => {
  it('splits off the first sentence', () => {
    expect(firstSentence('Paystack runs payments. It is part of Stripe.')).toEqual({ head: 'Paystack runs payments.', rest: 'It is part of Stripe.' })
    expect(firstSentence('One sentence only')).toEqual({ head: 'One sentence only', rest: '' })
  })
  it('writes date ranges without dashes', () => {
    expect(dateRange('2021', 'Present')).toBe('2021 to Present')
    expect(dateRange(null, '2018')).toBe('2018')
    expect(dateRange(null, null)).toBe('')
  })
  it('labels a source by host and first path segment', () => {
    expect(hostOf('https://www.paystack.com/blog/post-1')).toBe('paystack.com/blog')
    expect(hostOf('https://x.com')).toBe('x.com')
  })
  it('prefers a real rescore over the estimate', () => {
    expect(shownScore({ before: 70, projected: 80, current: 75, rescored: 82, decided: 1, pending: 0 })).toBe(82)
    expect(shownScore({ before: 70, projected: 80, current: 75, rescored: null, decided: 1, pending: 0 })).toBe(75)
    expect(shownScore(undefined)).toBeNull()
  })
})

describe('highlights', () => {
  const rewrites: Rewrites = {
    summary: { original: 'Old summary.', proposed: 'New summary.', status: 'accepted' },
    rewrites: [
      { id: '1', bullet_id: 'E1.B1', section: 'N', original: 'a', rewrite: 'Accepted text', why: null, needs_number: false, status: 'accepted', final_text: null },
      { id: '2', bullet_id: 'E1.B2', section: 'N', original: 'b', rewrite: 'Proposed only', why: null, needs_number: false, status: 'edited', final_text: 'My own words' },
      { id: '3', bullet_id: 'E1.B3', section: 'N', original: 'c', rewrite: 'Still pending', why: null, needs_number: false, status: 'pending', final_text: null },
    ],
    score: { before: 70, projected: 80, current: 75, rescored: null, decided: 2, pending: 1 },
  }

  it('counts only decisions the user made', () => {
    const set = changedTexts(rewrites, [])
    expect([...set].sort()).toEqual(['Accepted text', 'My own words', 'New summary.'])
    const doc = {
      header: { name: 'Ada' }, summary: 'New summary.', education: [], skills: [],
      experience: [{ role: 'r', company: 'c', bullets: ['Accepted text', 'My own words', 'c'] }],
    }
    expect(countChanged(doc, set)).toBe(3)
  })

  it('matches PDF lines only on word edges', () => {
    expect(containsAtWordBoundary('Experienced with Postgres', 'Experience')).toBe(false)
    expect(containsAtWordBoundary('Built the API, then Experience grew', 'Experience')).toBe(true)
    expect(containsAtWordBoundary('cut time by 60%', 'cut time by 60%')).toBe(true)
  })
})
