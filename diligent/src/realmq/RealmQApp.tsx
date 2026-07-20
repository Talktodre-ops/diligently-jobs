import { Component, type ReactNode, useEffect, useState } from "react"
import { AlertTriangle } from "lucide-react"
import { sidecar } from "./api"
import { Sidebar, type View } from "./Sidebar"
import { StatusView } from "./StatusView"
import { PantryView } from "./PantryView"
import { AuthorView } from "./AuthorView"
import { TrackerView } from "./TrackerView"

/** Catches uncaught render errors so a buggy panel doesn't wipe the whole shell.
 *  Without this, a single throw (e.g. hook-order violation) renders a blank
 *  window with no clue what broke. */
class PanelErrorBoundary extends Component<
  { panel: string; children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, info: { componentStack?: string }) {
    console.error(`[${this.props.panel}] uncaught render error:`, error, info)
  }
  render() {
    if (this.state.error) {
      return (
        <div className="mx-auto max-w-3xl p-6">
          <div className="flex items-start gap-3 rounded-xl border border-red-500/30 bg-red-500/10 p-4">
            <AlertTriangle className="mt-0.5 size-4 text-red-500" />
            <div className="space-y-1 min-w-0">
              <p className="text-sm font-medium">
                The <span className="font-mono">{this.props.panel}</span> view crashed
              </p>
              <p className="text-xs text-muted-foreground break-words">
                {this.state.error.message}
              </p>
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/30 p-2 font-mono text-[10px]">
                {this.state.error.stack ?? "(no stack)"}
              </pre>
              <button
                onClick={() => this.setState({ error: null })}
                className="mt-2 inline-flex rounded-md border border-border bg-background px-2 py-1 text-[11px] hover:bg-muted"
              >
                Try again
              </button>
            </div>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

type Health =
  | { kind: "loading" }
  | { kind: "ready"; port: number; version: string }
  | { kind: "error"; message: string }

export function RealmQApp() {
  const [view, setView] = useState<View>("status")
  const [health, setHealth] = useState<Health>({ kind: "loading" })

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const port = await (await import("./api")).sidecarPort()
        const h = await sidecar.health()
        if (!cancelled) {
          setHealth({ kind: "ready", port, version: h.version })
        }
      } catch (e) {
        if (!cancelled) {
          setHealth({
            kind: "error",
            message: e instanceof Error ? e.message : String(e),
          })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="flex h-screen bg-background text-foreground">
      <Sidebar view={view} onChange={setView} health={health} />
      <main className="flex-1 overflow-auto">
        {view === "status" && (
          <PanelErrorBoundary panel="status" key="status">
            <StatusView health={health} />
          </PanelErrorBoundary>
        )}
        {view === "pantry" && (
          <PanelErrorBoundary panel="pantry" key="pantry">
            {health.kind !== "error" ? <PantryView /> : <NeedSidecar />}
          </PanelErrorBoundary>
        )}
        {view === "author" && (
          <PanelErrorBoundary panel="author" key="author">
            {health.kind !== "error" ? <AuthorView /> : <NeedSidecar />}
          </PanelErrorBoundary>
        )}
        {view === "tracker" && (
          <PanelErrorBoundary panel="tracker" key="tracker">
            {health.kind !== "error" ? <TrackerView /> : <NeedSidecar />}
          </PanelErrorBoundary>
        )}
      </main>
    </div>
  )
}

function NeedSidecar() {
  return (
    <div className="mx-auto max-w-3xl p-6 text-sm text-muted-foreground">
      This view needs the sidecar — see the Status tab for details.
    </div>
  )
}
