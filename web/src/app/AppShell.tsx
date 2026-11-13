import { NavLink, Outlet } from 'react-router'
import { Icon, type IconName } from '../ui/Icon'
import { ThemeSync } from './ThemeSync'
import { UsageCard } from './UsageCard'
import s from './AppShell.module.css'

const sections: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: '/', label: 'Home', icon: 'home', end: true },
  { to: '/jobs', label: 'Jobs', icon: 'jobs' },
  { to: '/documents', label: 'Documents', icon: 'document' },
  { to: '/profile', label: 'Profile', icon: 'profile' },
]

/**
 * Phone: content plus a bottom tab bar on the four top-level sections; pushed
 * screens (a job's workspace, review, settings) hide the tab bar and bring
 * their own back button. Desktop (1024px and up): a persistent side menu.
 */
export function AppShell({ tabs }: { tabs: boolean }) {
  return (
    <div className={[s.shell, tabs && s.withTabs].filter(Boolean).join(' ')}>
      <ThemeSync />
      <nav className={s.sidebar} aria-label="Main">
        <NavLink to="/" className={s.brand}>diligently<span>.</span></NavLink>
        {sections.map((x) => (
          <NavLink key={x.to} to={x.to} end={x.end} className={({ isActive }) => [s.navlink, isActive && s.active].filter(Boolean).join(' ')}>
            {({ isActive }) => (<><Icon name={x.icon} filled={isActive ? 'var(--butter)' : undefined} />{x.label}</>)}
          </NavLink>
        ))}
        <div className={s.spacer} />
        <UsageCard />
      </nav>
      <main className={s.main}>
        <Outlet />
      </main>
      {tabs && (
        <nav className={s.tabbar} aria-label="Main">
          {sections.map((x) => (
            <NavLink key={x.to} to={x.to} end={x.end} className={({ isActive }) => [s.tab, isActive && s.active].filter(Boolean).join(' ')}>
              {({ isActive }) => (<><Icon name={x.icon} size={22} strokeWidth={isActive ? 2 : 1.8} filled={isActive ? 'var(--butter)' : undefined} />{x.label}</>)}
            </NavLink>
          ))}
        </nav>
      )}
    </div>
  )
}
