import { request, type APIRequestContext } from '@playwright/test'
import { latestMail, linkIn } from './outbox'

export const PASSWORD = 'e2e passphrase 2026'

/** A fresh address per test run so specs never collide with earlier runs. */
export function freshEmail(tag: string) {
  return `e2e-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e4)}@example.com`
}

const sampleCv = (name: string, email: string) => ({
  header: { name, title: 'Senior Backend Engineer', email },
  summary: 'Backend engineer with 7 years building payment and ledger systems in Go and Rust.',
  experience: [
    { role: 'Senior Backend Engineer', company: 'Northfold', location: 'Lagos', start: '2021', end: 'Present',
      bullets: ['Cut ledger reconciliation time by 60% by moving batch jobs to Kafka consumers in Go',
        'Designed the Postgres partitioning scheme for 400M payment rows',
        'Led a 4-person on-call rotation and wrote the incident runbooks'] },
    { role: 'Backend Engineer', company: 'Quarry Labs', start: '2018', end: '2021',
      bullets: ['Built the billing API in Rust used by 30 merchant integrations', 'Ran Terraform for 3 AWS accounts'] },
  ],
  skills: [{ label: 'Languages', items: ['Go', 'Rust', 'SQL'] }, { label: 'Infra', items: ['Postgres', 'Kafka', 'Kubernetes', 'Terraform'] }],
  education: [{ institution: 'University of Lagos', degree: 'B.Sc. Computer Science' }],
})

/**
 * Create a verified, onboarded account through the real API (sign up, read the
 * verification email from the outbox, verify, save a master CV, finish
 * onboarding). Specs then sign in through the real form with it.
 */
export async function createReadyAccount(baseURL: string, opts: { name?: string; tag?: string } = {}) {
  const email = freshEmail(opts.tag ?? 'ready')
  const name = opts.name ?? 'Ada Okafor'
  const ctx: APIRequestContext = await request.newContext({ baseURL, extraHTTPHeaders: { Origin: baseURL } })
  try {
    const signup = await ctx.post('/v1/auth/signup', { data: { email, password: PASSWORD } })
    if (signup.status() !== 201) throw new Error(`signup ${signup.status()}: ${await signup.text()}`)
    const link = linkIn(await latestMail(email, '/verify-email'), '/verify-email')
    const token = new URL(link).searchParams.get('token')
    const verify = await ctx.post('/v1/auth/verify', { data: { token } })
    if (!verify.ok()) throw new Error(`verify ${verify.status()}`)
    const cv = await ctx.put('/v1/cv/master', { data: { doc: sampleCv(name, email) } })
    if (!cv.ok()) throw new Error(`master cv ${cv.status()}: ${await cv.text()}`)
    const prof = await ctx.patch('/v1/profile', {
      data: { full_name: name, target_roles: ['Senior Backend Engineer'], work_settings: ['remote'], onboarding_step: 'done' },
    })
    if (!prof.ok()) throw new Error(`profile ${prof.status()}: ${await prof.text()}`)
    return { email, password: PASSWORD, name }
  } finally {
    await ctx.dispose()
  }
}
