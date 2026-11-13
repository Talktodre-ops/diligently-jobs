import { Link } from 'react-router'
import { useProfile } from '../../auth/session'
import { ButtonLink } from '../../ui/Button'
import { Icon } from '../../ui/Icon'
import { PageState } from '../../ui/PageState'
import { countWord, greeting } from '../apply/format'
import { DESKTOP, useMediaQuery } from '../../ui/useMediaQuery'
import { useApplications, useHome } from './api'
import { Composer } from './Composer'
import { NeedsYou } from './NeedsYou'
import { Pipeline } from './Pipeline'
import { ThisWeek } from './ThisWeek'
import s from './HomePage.module.css'

function initials(name: string | null | undefined) {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean)
  return parts.slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?'
}

function needsLine(n: number, empty: boolean) {
  if (empty) return 'Paste a job you want and we will tailor your CV to it.'
  if (n === 0) return 'Nothing needs you right now.'
  return `${countWord(n)} ${n === 1 ? 'thing needs' : 'things need'} you today.`
}

function composerLine(n: number, empty: boolean) {
  if (empty) return 'Paste a job you want and we will tailor your CV to it.'
  if (n === 0) return 'Nothing needs you right now. Start a new one?'
  return `${countWord(n)} ${n === 1 ? 'thing needs' : 'things need'} you. Or start a new one.`
}

export default function HomePage() {
  const home = useHome()
  const apps = useApplications()
  const profile = useProfile()
  const desktop = useMediaQuery(DESKTOP)

  if (home.isPending) return <PageState.Loading />
  if (home.isError) return <PageState.Error error={home.error} onRetry={() => home.refetch()} />

  const { first_name, needs_you, this_week } = home.data
  const hello = `${greeting()}${first_name ? `, ${first_name}` : ''}.`
  // A brand-new account has no applications at all: Home leads with the first step.
  const empty = apps.data?.length === 0 && needs_you.length === 0 && this_week.length === 0

  return (
    <div className={s.page}>
      {!desktop && (
        <header className={s.header}>
          <span className={s.brand}>diligently<span>.</span></span>
          <Link to="/profile" className={s.avatar} aria-label="Your profile">
            {initials(profile.data?.full_name ?? first_name)}
          </Link>
        </header>
      )}

      <div className={s.content}>
        {desktop ? (
          <Composer title={hello} line={composerLine(needs_you.length, empty)} />
        ) : (
          <div className={s.hello}>
            <h1 className={s.h1}>{hello}</h1>
            <p className={s.lede}>{needsLine(needs_you.length, empty)}</p>
          </div>
        )}

        <div className={s.columns}>
          <div className={s.main}>
            {empty && !desktop ? <FirstJob /> : <NeedsYou cards={needs_you} desktop={desktop} />}
            <ThisWeek events={this_week} desktop={desktop} />
          </div>
          {desktop && <Pipeline apps={apps} cards={needs_you} />}
        </div>
      </div>

      {!desktop && (
        <ButtonLink to="/new" className={s.fab} aria-label="New application">
          <Icon name="plus" size={22} strokeWidth={2.2} />
          New job
        </ButtonLink>
      )}
    </div>
  )
}

/** The empty state on a phone: one clear first step. */
function FirstJob() {
  return (
    <section aria-label="Your first application" className={s.first}>
      <div className={s.eyebrow}>Your first application</div>
      <p className={s.firstBody}>
        Paste a job description or a link. We tailor your CV to it and score the match. Nothing changes on your CV until you say so.
      </p>
      <ButtonLink to="/new" variant="dark" small>
        Start with a job
      </ButtonLink>
    </section>
  )
}
