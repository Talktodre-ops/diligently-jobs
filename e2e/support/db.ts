import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Read-only lookups in the dev stack's database for values the API never
// hands out (an email's unsubscribe token). Needs the host's docker CLI and
// the compose stack running; callers skip their test when this throws.
const root = fileURLToPath(new URL('../..', import.meta.url))

/** The unsubscribe token the API puts in this user's optional emails. */
export function unsubscribeToken(email: string): string {
  const out = execFileSync(
    'docker',
    ['compose', 'exec', '-T', 'db', 'sh', '-c', 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -v ON_ERROR_STOP=1 -v email="$1"', '_', email],
    { cwd: root, input: "select unsubscribe_token from users where lower(email) = lower(:'email');\n", encoding: 'utf8', timeout: 20_000 },
  ).trim()
  if (!/^[0-9a-f]{16,}$/i.test(out)) throw new Error(`no unsubscribe token for ${email}`)
  return out
}
