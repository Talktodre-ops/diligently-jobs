// After a deploy, a tab that was already open still runs the old build. Its
// next lazy screen asks for a chunk the server no longer has (the API answers
// 404 for a missing /assets/ file), and Vite reports that as
// `vite:preloadError`. A full reload picks up the new build. The guard allows
// one reload per 30 seconds, so a real bug cannot loop.

const KEY = 'diligently:reloaded-for-build'
const WINDOW_MS = 30_000

type Store = Pick<Storage, 'getItem' | 'setItem'>

/** Reloads unless it already did within the window. Returns whether it reloaded. */
export function reloadOnceForNewBuild(now: number, store: Store, reload: () => void): boolean {
  try {
    if (now - Number(store.getItem(KEY) ?? 0) < WINDOW_MS) return false
    store.setItem(KEY, String(now))
  } catch {
    // Without storage there is no guard against a loop, so do not reload.
    return false
  }
  reload()
  return true
}

export function installStaleBuildRecovery() {
  window.addEventListener('vite:preloadError', (event) => {
    if (reloadOnceForNewBuild(Date.now(), sessionStorage, () => window.location.reload())) event.preventDefault()
  })
}
