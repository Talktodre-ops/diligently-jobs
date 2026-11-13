import { useId, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useParams } from 'react-router'
import { companyName, useBrief } from '../apply/api'
import { DESKTOP, useMediaQuery } from '../../ui/useMediaQuery'
import { Button } from '../../ui/Button'
import { Icon } from '../../ui/Icon'
import { Notice } from '../../ui/Notice'
import { PageState } from '../../ui/PageState'
import { TopBar } from '../../ui/TopBar'
import { useRefreshResearch, useResearch, type Research } from './api'
import { firstSentence, longDate } from './format'
import { OverviewSection, SourceList, TalkingPoints } from './ResearchSections'
import s from './Research.module.css'

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'points', label: 'Talking points' },
  { id: 'sources', label: 'Sources' },
] as const
type TabId = (typeof TABS)[number]['id']

const isThin = (r: Research) =>
  !r.brief.overview && !r.brief.why_them && r.brief.products.length + r.brief.culture.length + r.brief.recent_news.length + r.brief.talking_points.length === 0

/** The overview's first sentence makes the headline when it is short enough to read as one. */
function headline(r: Research, company: string) {
  const overview = r.brief.overview
  if (!overview) return { head: `What the web says about ${company}`, rest: '' }
  const split = firstSentence(overview)
  return split.head.length <= 140 ? split : { head: `About ${company}`, rest: overview }
}

export default function ResearchPage() {
  const { id = '' } = useParams()
  const brief = useBrief(id)
  const research = useResearch(id)
  const refresh = useRefreshResearch(id)
  const desktop = useMediaQuery(DESKTOP)
  const [tab, setTab] = useState<TabId>('overview')
  const base = useId()

  const company = companyName(brief.data?.application.company)
  const back = `/applications/${id}`
  const top = (end?: ReactNode) => <TopBar back={back} backLabel="Back to application" eyebrow="Research" title={company} end={end} />

  if (brief.isPending || research.isPending) return (<>{top()}<PageState.Loading label="Loading research" /></>)
  if (brief.isError) return (<>{top()}<PageState.Error error={brief.error} onRetry={() => brief.refetch()} /></>)
  if (research.isError) return (<>{top()}<PageState.Error error={research.error} onRetry={() => research.refetch()} /></>)

  const refreshError = refresh.isError ? <Notice tone="error">{refresh.error.message}</Notice> : null
  const r = research.data

  if (!r) {
    return (
      <>
        {top()}
        <div className={s.emptyWrap}>
          <PageState.Empty
            title="No research yet"
            body={`We can look ${company} up on the web and pull out what is worth knowing before you apply.`}
            action={<Button busy={refresh.isPending} onClick={() => refresh.mutate()}>Research {company}</Button>}
          />
          {refreshError}
        </div>
      </>
    )
  }

  const { head, rest } = headline(r, company)
  const refreshButton = (
    <Button variant="ghost" small iconOnly aria-label="Search again for new research" busy={refresh.isPending} onClick={() => refresh.mutate()}>
      {!refresh.isPending && <Icon name="refresh" size={20} />}
    </Button>
  )

  const panels: Record<TabId, ReactNode> = {
    overview: <OverviewSection brief={r.brief} rest={rest} sources={r.sources} />,
    points: <TalkingPoints points={r.brief.talking_points} sources={r.sources} company={company} />,
    sources: <SourceList sources={r.sources} />,
  }

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]!
    setTab(next.id)
    document.getElementById(`${base}-tab-${next.id}`)?.focus()
  }

  return (
    <>
      {top(refreshButton)}
      <div className={s.page}>
        <header className={s.head}>
          <h1 className={[s.h1, head.length > 90 && s.h1Long].filter(Boolean).join(' ')}>{head}</h1>
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

        {desktop ? (
          <div className={s.columns}>
            <section className={s.column} aria-labelledby={`${base}-h-overview`}>
              <h2 id={`${base}-h-overview`} className={s.columnTitle}>Overview</h2>
              {panels.overview}
            </section>
            <div className={s.column}>
              <section className={s.column} aria-labelledby={`${base}-h-points`}>
                <h2 id={`${base}-h-points`} className={s.columnTitle}>Talking points</h2>
                {panels.points}
              </section>
              <section className={s.column} aria-labelledby={`${base}-h-sources`}>
                <h2 id={`${base}-h-sources`} className={s.columnTitle}>Sources</h2>
                {panels.sources}
              </section>
            </div>
          </div>
        ) : (
          <>
            <div role="tablist" aria-label="Research sections" className={s.tabs}>
              {TABS.map((t, i) => (
                <button
                  key={t.id}
                  id={`${base}-tab-${t.id}`}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  aria-controls={`${base}-panel`}
                  tabIndex={tab === t.id ? 0 : -1}
                  className={s.tab}
                  onClick={() => setTab(t.id)}
                  onKeyDown={(e) => onTabKey(e, i)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div id={`${base}-panel`} role="tabpanel" aria-labelledby={`${base}-tab-${tab}`} className={s.panel} tabIndex={0}>
              {panels[tab]}
            </div>
          </>
        )}
      </div>
    </>
  )
}
