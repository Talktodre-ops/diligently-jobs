import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

// The dev API writes every email it would send into MAIL_OUTBOX_DIR
// (backend/.outbox), mounted here read-only at /outbox.
const dir = process.env.OUTBOX_DIR ?? '/outbox'

type Mail = { to: string; subject: string; text: string }

/** Newest email to `to` whose text contains `contains`, waiting up to `timeoutMs`. */
export async function latestMail(to: string, contains: string, timeoutMs = 15_000): Promise<Mail> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.json')).sort().reverse()
    for (const f of files) {
      const mail = JSON.parse(await readFile(join(dir, f), 'utf8')) as Mail
      if (mail.to.toLowerCase() === to.toLowerCase() && mail.text.includes(contains)) return mail
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`no email to ${to} containing "${contains}" within ${timeoutMs}ms`)
}

/** The first link in an email whose path is `path` (e.g. /verify-email). */
export function linkIn(mail: Mail, path: string): string {
  const m = mail.text.match(new RegExp(`https?://[^\\s]+${path.replace('/', '\\/')}\\?token=[^\\s]+`))
  if (!m) throw new Error(`no ${path} link in email "${mail.subject}"`)
  return m[0]
}
