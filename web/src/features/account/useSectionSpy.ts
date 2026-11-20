import { useEffect, useState } from 'react'

/**
 * The id of the section the reader is looking at: the first one, in page
 * order, that crosses the band just under the header. Falls back to the first
 * id where IntersectionObserver is missing (tests, very old browsers).
 */
export function useSectionSpy(ids: readonly string[], enabled = true) {
  const [active, setActive] = useState(ids[0] ?? '')
  const key = ids.join('|')

  useEffect(() => {
    if (!enabled || typeof IntersectionObserver === 'undefined') return
    const visible = new Set<string>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target.id)
          else visible.delete(e.target.id)
        }
        const first = ids.find((id) => visible.has(id))
        if (first) setActive(first)
      },
      // A band from below the sticky header to 55% up from the bottom.
      { rootMargin: '-96px 0px -55% 0px' },
    )
    for (const id of ids) {
      const el = document.getElementById(id)
      if (el) observer.observe(el)
    }
    return () => observer.disconnect()
    // `key` stands in for the ids array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled])

  return [active, setActive] as const
}
