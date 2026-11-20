import { useCallback, useEffect, useState } from 'react'

/** A seconds countdown that ticks once a second after start(n), optionally already running. */
export function useCooldown(initial = 0) {
  const [secs, setSecs] = useState(initial)
  useEffect(() => {
    if (secs <= 0) return
    const t = setTimeout(() => setSecs((v) => v - 1), 1000)
    return () => clearTimeout(t)
  }, [secs])
  const start = useCallback((n: number) => setSecs(Math.max(0, Math.ceil(n))), [])
  return { secs, start }
}
