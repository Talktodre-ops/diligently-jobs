import { Sparkles, Database, Activity, FileText, Search, Send, BarChart3, Settings as SettingsIcon } from "lucide-react"

export type View = "status" | "pantry" | "author" | "research" | "proposals" | "tracker" | "settings"

interface NavItem {
  view: View
  label: string
  icon: React.ComponentType<{ className?: string }>
  enabled: boolean
}

const ITEMS: NavItem[] = [
  { view: "status",    label: "Status",     icon: Activity,     enabled: true },
  { view: "pantry",    label: "Pantry",     icon: Database,     enabled: true },
  { view: "author",    label: "Author",     icon: FileText,     enabled: true },
  { view: "tracker",   label: "Tracker",    icon: BarChart3,    enabled: true },
  { view: "research",  label: "Research",   icon: Search,       enabled: false },
  { view: "proposals", label: "Proposals",  icon: Send,         enabled: false },
  { view: "settings",  label: "Settings",   icon: SettingsIcon, enabled: false },
]

interface SidebarProps {
  view: View
  onChange: (view: View) => void
  health: { kind: "loading" } | { kind: "ready"; port: number; version: string } | { kind: "error"; message: string }
}

export function Sidebar({ view, onChange, health }: SidebarProps) {
  return (
    <aside className="flex h-screen w-56 shrink-0 flex-col border-r border-border bg-card">
      <div className="flex h-14 items-center gap-2 border-b border-border px-4">
        <div className="flex size-8 items-center justify-center rounded-lg bg-foreground">
          <Sparkles className="size-5 text-background" />
        </div>
        <div className="leading-tight">
          <p className="text-sm font-semibold">RealmQ Studio</p>
          <p className="text-[10px] text-muted-foreground">Task cockpit</p>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto p-2">
        {ITEMS.map((item) => {
          const active = item.view === view
          return (
            <button
              key={item.view}
              disabled={!item.enabled}
              onClick={() => item.enabled && onChange(item.view)}
              className={`mb-0.5 flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                active
                  ? "bg-muted font-medium text-foreground"
                  : item.enabled
                    ? "text-muted-foreground hover:bg-muted hover:text-foreground"
                    : "text-muted-foreground/40 cursor-not-allowed"
              }`}
            >
              <item.icon className="size-4" />
              <span className="flex-1">{item.label}</span>
              {!item.enabled && (
                <span className="text-[10px] text-muted-foreground/60">soon</span>
              )}
            </button>
          )
        })}
      </nav>

      <div className="border-t border-border p-3">
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Sidecar
        </p>
        {health.kind === "loading" && (
          <p className="text-xs text-muted-foreground">connecting…</p>
        )}
        {health.kind === "ready" && (
          <div className="flex items-center gap-2 text-xs">
            <span className="size-2 rounded-full bg-emerald-500" />
            <span className="text-foreground">:{health.port}</span>
            <span className="text-muted-foreground">v{health.version}</span>
          </div>
        )}
        {health.kind === "error" && (
          <div className="text-xs text-amber-500" title={health.message}>
            unreachable
          </div>
        )}
      </div>
    </aside>
  )
}
