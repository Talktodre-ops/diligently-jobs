import { describe, expect, it, vi } from 'vitest'
import { reloadOnceForNewBuild } from './staleBuild'

const store = () => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
}

describe('reloadOnceForNewBuild', () => {
  it('reloads once, then not again within 30 seconds, then again after', () => {
    const s = store()
    const reload = vi.fn()
    expect(reloadOnceForNewBuild(1_000_000, s, reload)).toBe(true)
    expect(reloadOnceForNewBuild(1_010_000, s, reload)).toBe(false)
    expect(reloadOnceForNewBuild(1_031_000, s, reload)).toBe(true)
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('does not reload when storage is unavailable, so it cannot loop', () => {
    const reload = vi.fn()
    const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => {} }
    expect(reloadOnceForNewBuild(1, broken, reload)).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })
})
