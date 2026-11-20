import { Link } from 'react-router'
import { Icon } from '../../ui/Icon'
import { useHideSetup, type Setup } from './api'
import s from './SetupCard.module.css'

type Milestone = {
  key: 'cv' | 'check' | 'targets' | 'first_application'
  title: string
  sub: string
  time: string
  to: string
  /** Needs a CV before it can start. */
  needsCv?: boolean
}

const milestones: Milestone[] = [
  { key: 'cv', title: 'Add your CV', sub: 'Every application is tailored from it.', time: '2 min', to: '/onboarding/upload' },
  { key: 'check', title: 'Check what we read', sub: 'Fix anything we got wrong, fill the gaps.', time: '3 min', to: '/onboarding/check', needsCv: true },
  { key: 'targets', title: 'Say what you want', sub: 'Roles and where you would work.', time: '1 min', to: '/onboarding/targets' },
  { key: 'first_application', title: 'Tailor your first CV', sub: 'Paste a job you want.', time: '2 min', to: '/new', needsCv: true },
]

/**
 * The setup steps that are left, on Home. Each one opens its screen and comes
 * back here when done. Hide keeps the card away for a week on every device;
 * the server decides when it shows (setup.show).
 */
export function SetupCard({ setup }: { setup: Setup }) {
  const hide = useHideSetup()
  if (!setup.show) return null
  const doneCount = milestones.filter((m) => setup[m.key]).length

  return (
    <section aria-labelledby="setup-h" className={s.card}>
      <div className={s.head}>
        <div>
          <h2 id="setup-h" className={s.kicker}>Get set up</h2>
          <p className={s.count}>{doneCount} of {milestones.length} done</p>
        </div>
        <button type="button" className={s.hide} disabled={hide.isPending} onClick={() => hide.mutate()} aria-describedby="setup-hide-note">
          Hide
        </button>
        <span id="setup-hide-note" className={s.srOnly}>Hides this for a week</span>
      </div>
      <div className={s.bars} aria-hidden="true">
        {milestones.map((m) => <span key={m.key} className={setup[m.key] ? s.barDone : s.bar} />)}
      </div>
      {hide.isError && <p role="alert" className={s.error}>Could not hide this. Try again.</p>}
      <ol className={s.list}>
        {milestones.map((m) => {
          const done = setup[m.key]
          const locked = !done && m.needsCv && !setup.cv
          const body = (
            <>
              <span className={done ? s.dotDone : s.dot} aria-hidden="true">
                {done && <Icon name="check" size={14} strokeWidth={3} />}
              </span>
              <span className={s.text}>
                <span className={done ? s.titleDone : s.title}>{m.title}</span>
                <span className={s.sub}>{done ? 'Done' : locked ? 'After you add your CV.' : m.sub}</span>
              </span>
              {!done && !locked && (
                <>
                  <span className={s.time}>{m.time}</span>
                  <Icon name="forward" size={18} className={s.chev} />
                </>
              )}
            </>
          )
          return (
            <li key={m.key} className={s.item}>
              {done || locked ? (
                <div className={locked ? s.rowLocked : s.row} aria-disabled={locked || undefined}>
                  {body}
                  <span className={s.srOnly}>{done ? ', done' : ', not available yet'}</span>
                </div>
              ) : (
                <Link to={m.to} className={s.row}>{body}</Link>
              )}
            </li>
          )
        })}
      </ol>
    </section>
  )
}
