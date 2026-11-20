import { useId } from 'react'
import { Button } from '../../ui/Button'
import { Icon } from '../../ui/Icon'
import { Notice } from '../../ui/Notice'
import { PageState } from '../../ui/PageState'
import { useRefreshResearch, useResearch, type Research } from './api'
import { firstSentence, longDate } from './format'
import { OverviewSection, SourceList, TalkingPoints } from './ResearchSections'
import s from './CompanyPanel.module.css'

const isThin = (r: Research) =>
  !r.brief.overview && !r.brief.why_them && r.brief.products.length + r.brief.culture.length + r.brief.recent_news.length + r.brief.talking_points.length === 0

/** The overview's first sentence makes the headline when it is short enough to read as one. */
function headline(r: Research, company: string) {
  const overview = r.brief.overview
  if (!overview) return { head: `What the web says about ${company}`, rest: '' }
  const split = firstSentence(overview)
  return split.head.length <= 140 ? split : { head: `About ${company}`, rest: overview }
}

/** The Company tab: what the web says about the employer, with sources, in one column. */
export function CompanyPanel({ id, company }: { id: string; company: string }) {
  const research = useResearch(id)
  const refresh = useRefreshResearch(id)
  const base = useId()

  if (research.isPending) return <PageState.Loading label="Loading research" />
  if (research.isError) return <PageState.Error error={research.error} onRetry={() => research.refetch()} />

  const refreshError = refresh.isError ? <Notice tone="error">{refresh.error.message}</Notice> : null
  const r = research.data

  if (!r) {
    return (
      <div className={s.emptyWrap}>
        <PageState.Empty
          title="No research yet"
          body={`We can look ${company} up on the web and pull out what is worth knowing before you apply.`}
          action={<Button busy={refresh.isPending} onClick={() => refresh.mutate()}>Research {company}</Button>}
        />
        {refreshError}
      </div>
    )
  }

  const { head, rest } = headline(r, company)
  return (
    <div className={s.panel}>
      <header className={s.head}>
        <div className={s.headRow}>
          <h2 className={[s.h1, head.length > 90 && s.h1Long].filter(Boolean).join(' ')}>{head}</h2>
          <Button variant="ghost" small iconOnly aria-label="Search again for new research" busy={refresh.isPending} onClick={() => refresh.mutate()}>
            {!refresh.isPending && <Icon name="refresh" size={20} />}
          </Button>
        </div>
        <p className={s.sub}>
          From {r.sources.length} web {r.sources.length === 1 ? 'source' : 'sources'}, gathered {longDate(r.created_at)}.
        </p>
        <div role="status" aria-live="polite" className={s.status}>
          {refresh.isPending ? 'Searching again. This takes a few seconds.' : refresh.isSuccess ? 'Research updated.' : ''}
        </div>
        {refreshError}
        {isThin(r) && (
          <Notice>We found little about {company} that we could stand behind. The sources are what came up; check them yourself, or search again later.</Notice>
        )}
      </header>

      <section className={s.column} aria-labelledby={`${base}-overview`}>
        <h3 id={`${base}-overview`} className={s.columnTitle}>Overview</h3>
        <OverviewSection brief={r.brief} rest={rest} sources={r.sources} />
      </section>
      <section className={s.column} aria-labelledby={`${base}-points`}>
        <h3 id={`${base}-points`} className={s.columnTitle}>Talking points</h3>
        <TalkingPoints points={r.brief.talking_points} sources={r.sources} company={company} />
      </section>
      <section className={s.column} aria-labelledby={`${base}-sources`}>
        <h3 id={`${base}-sources`} className={s.columnTitle}>Sources</h3>
        <SourceList sources={r.sources} />
      </section>
    </div>
  )
}
