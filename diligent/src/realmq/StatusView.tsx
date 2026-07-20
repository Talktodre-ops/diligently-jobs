import { CheckCircle2, AlertTriangle, Loader2, ExternalLink } from "lucide-react"

interface StatusViewProps {
  health: { kind: "loading" } | { kind: "ready"; port: number; version: string } | { kind: "error"; message: string }
}

export function StatusView({ health }: StatusViewProps) {
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Status</h1>
        <p className="text-sm text-muted-foreground">
          Sidecar health and the modules wired in so far.
        </p>
      </header>

      <section className="rounded-xl border border-border bg-card p-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Sidecar status
        </h2>
        <div className="mt-3 flex items-start gap-3">
          {health.kind === "loading" && (
            <>
              <Loader2 className="mt-0.5 size-4 animate-spin text-muted-foreground" />
              <p className="text-sm">Connecting to sidecar…</p>
            </>
          )}
          {health.kind === "ready" && (
            <>
              <CheckCircle2 className="mt-0.5 size-4 text-emerald-500" />
              <div>
                <p className="text-sm font-medium">
                  Sidecar ready — port :{health.port}
                </p>
                <p className="text-xs text-muted-foreground">
                  FastAPI v{health.version} · localhost only · Tauri ↔ Python
                  handshake verified.
                </p>
              </div>
            </>
          )}
          {health.kind === "error" && (
            <>
              <AlertTriangle className="mt-0.5 size-4 text-amber-500" />
              <div>
                <p className="text-sm font-medium">Sidecar unreachable</p>
                <p className="mt-0.5 text-xs text-muted-foreground break-words">
                  {health.message}
                </p>
              </div>
            </>
          )}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Modules
        </h2>
        <ul className="mt-3 space-y-1.5 text-sm">
          {[
            { name: "01 · Data Pantry", status: "live" },
            { name: "02 · Chart Recipes", status: "live (1 of 6)" },
            { name: "04 · Authoring Workspace", status: "next" },
            { name: "05 · Compute-Answer", status: "next" },
            { name: "06 · Policy Linter", status: "soon" },
            { name: "07 · Rollout Pre-check", status: "soon" },
            { name: "08 · Submission Tracker", status: "soon" },
            { name: "09 · Audit / Provenance", status: "soon" },
            { name: "10 · Question Ideation", status: "soon" },
          ].map((m) => (
            <li key={m.name} className="flex items-center justify-between">
              <span>{m.name}</span>
              <span
                className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${
                  m.status === "live"
                    ? "border-emerald-500/40 text-emerald-500"
                    : m.status === "next"
                      ? "border-blue-500/40 text-blue-500"
                      : "border-border text-muted-foreground"
                }`}
              >
                {m.status}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ExternalLink className="size-3" />
        Open the <strong>Pantry</strong> tab to see the first dataset + render a chart.
      </p>
    </div>
  )
}
