import { useState } from 'react'
import { useGaps, useTailoredCv } from './api'
import { GapCard, handled } from './GapCard'
import s from './Questions.module.css'

/**
 * Requirements the CV does not fully show, asked one at a time above the CV.
 * Answers only add what the person says is true. Once all are answered, the
 * answers fold away and can be opened to change one.
 */
export function Questions({ appId }: { appId: string }) {
  const gaps = useGaps(appId)
  const cv = useTailoredCv(appId)
  const roles = (cv.data?.doc.experience ?? []).map((e) => `${e.role} at ${e.company}`)
  const [later, setLater] = useState<string[]>([])
  const [showAnswers, setShowAnswers] = useState(false)

  if (gaps.isPending) return null
  if (gaps.isError) {
    return (
      <p className={s.quiet}>
        Questions did not load. <button type="button" className={s.link} onClick={() => gaps.refetch()}>Try again</button>
      </p>
    )
  }

  const open = gaps.data.gaps.filter((g) => g.status !== 'covered')
  if (open.length === 0) return null
  const unanswered = open.filter((g) => !handled(g))

  if (unanswered.length === 0) {
    return (
      <section aria-labelledby="answers-title" className={s.done}>
        <div className={s.head}>
          <h2 id="answers-title" className={s.titleQuiet}>You answered {open.length === 1 ? 'the question' : `all ${open.length} questions`}</h2>
          <button type="button" className={s.link} aria-expanded={showAnswers} onClick={() => setShowAnswers((v) => !v)}>
            {showAnswers ? 'Hide answers' : 'See answers'}
          </button>
        </div>
        {showAnswers && (
          <ul className={s.list}>
            {open.map((g) => <li key={g.id}><GapCard appId={appId} gap={g} roles={roles} /></li>)}
          </ul>
        )}
      </section>
    )
  }

  // "Ask me later" sends a question to the back of the queue.
  const queue = [...unanswered.filter((g) => !later.includes(g.id)), ...unanswered.filter((g) => later.includes(g.id))]
  const current = queue[0]!
  const n = unanswered.length

  return (
    <section aria-labelledby="questions-title" className={s.card}>
      <div className={s.head}>
        <h2 id="questions-title" className={s.title}>
          {n === 1 ? 'One question would make this stronger' : `${n} questions would make this stronger`}
        </h2>
        {n > 1 && (
          <button type="button" className={s.link} onClick={() => setLater((l) => [...l.filter((x) => x !== current.id), current.id])}>
            Ask me later
          </button>
        )}
      </div>
      <p className={s.lede}>We only add what you tell us is true.</p>
      <GapCard key={current.id} appId={appId} gap={current} roles={roles} />
    </section>
  )
}
