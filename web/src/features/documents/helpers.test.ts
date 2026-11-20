import { describe, expect, it } from 'vitest'
import { fileNameFromUrl, firstSentence, hostOf, shownScore } from './format'

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
