// Sign-up is limited to 10 per hour per IP and the dev stack is shared, so a
// spec that creates accounts may have to wait for the limiter to refill.
export async function retryWhileRateLimited<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (e) {
      if (i >= tries || !/\b429\b|rate_limited/.test(String(e))) throw e
      await new Promise((r) => setTimeout(r, 30_000))
    }
  }
}
