import { useState } from "react"
import { ChevronDown, ChevronRight, Download, FileSpreadsheet, Image as ImageIcon, Check } from "lucide-react"
import type { RenderResponse } from "./api"

/** Trigger a browser download in the Tauri WebView2 context.
 *
 *  Tauri 2 webviews accept anchor downloads with a data: URL — the previous
 *  download issue in this app was with blob: URLs from Mermaid, not data:.
 *  We construct the anchor, attach to DOM, click, detach. Synchronous; no
 *  permissions or Tauri plugins required.
 */
function downloadDataUrl(dataUrl: string, filename: string) {
  const a = document.createElement("a")
  a.href = dataUrl
  a.download = filename
  a.style.display = "none"
  document.body.appendChild(a)
  a.click()
  // Defer removal so the click event has a chance to fire fully before GC.
  setTimeout(() => document.body.removeChild(a), 0)
}

function recordsToCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return ""
  const cols = Object.keys(rows[0])
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return ""
    const s = typeof v === "string" ? v : JSON.stringify(v)
    // Quote any cell containing comma, quote, or newline; double-up embedded quotes per RFC 4180.
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [cols.join(",")]
  for (const r of rows) lines.push(cols.map((c) => escape(r[c])).join(","))
  return lines.join("\r\n")
}

export function ChartViewer({ result }: { result: RenderResponse }) {
  const [showData, setShowData] = useState(false)
  const [downloaded, setDownloaded] = useState<"png" | "csv" | null>(null)
  const m = result.metadata

  // Stable filename root: dataset + recipe + first 8 chars of fingerprint so
  // multiple downloads from the same session don't overwrite each other.
  const baseName = `${result.dataset_id}__${m.recipe_id}__${m.fingerprint.slice(0, 8)}`

  const flashDownloaded = (kind: "png" | "csv") => {
    setDownloaded(kind)
    setTimeout(() => setDownloaded(null), 1500)
  }

  const downloadPng = () => {
    downloadDataUrl(`data:image/png;base64,${result.png_b64}`, `${baseName}.png`)
    flashDownloaded("png")
  }
  const downloadCsv = () => {
    const csv = recordsToCsv(result.records)
    const dataUrl = "data:text/csv;charset=utf-8," + encodeURIComponent(csv)
    downloadDataUrl(dataUrl, `${baseName}.csv`)
    flashDownloaded("csv")
  }

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-border bg-white p-3">
        <img
          src={`data:image/png;base64,${result.png_b64}`}
          alt={`${m.recipe_id} on ${result.dataset_id}`}
          className="block w-full"
        />
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-2">
          <button
            onClick={downloadPng}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs hover:bg-muted"
            title="Save the rendered chart as PNG"
          >
            {downloaded === "png" ? (
              <>
                <Check className="size-3.5 text-emerald-500" />
                PNG saved
              </>
            ) : (
              <>
                <ImageIcon className="size-3.5" />
                Download PNG
              </>
            )}
          </button>
          <button
            onClick={downloadCsv}
            disabled={result.records.length === 0}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-50"
            title="Save the underlying records as CSV — the data feeding the chart"
          >
            {downloaded === "csv" ? (
              <>
                <Check className="size-3.5 text-emerald-500" />
                CSV saved
              </>
            ) : (
              <>
                <FileSpreadsheet className="size-3.5" />
                Download CSV ({result.records.length} rows)
              </>
            )}
          </button>
          <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-muted-foreground">
            <Download className="size-3" />
            saved as <span className="font-mono">{baseName}.…</span>
          </span>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-3 text-xs">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <span>
            <span className="text-muted-foreground">Recipe</span>{" "}
            <span className="font-mono">{m.recipe_id}</span>
          </span>
          <span>
            <span className="text-muted-foreground">Theme</span>{" "}
            <span className="font-mono">{m.theme}</span>
          </span>
          <span>
            <span className="text-muted-foreground">Palette</span>{" "}
            <span className="font-mono">{m.palette}</span>
          </span>
          <span>
            <span className="text-muted-foreground">Panels</span>{" "}
            <span className="font-mono">{m.n_panels}</span>
          </span>
          <span>
            <span className="text-muted-foreground">Series</span>{" "}
            <span className="font-mono">{m.n_series}</span>
          </span>
          <span>
            <span className="text-muted-foreground">Rows used</span>{" "}
            <span className="font-mono">{m.rows_used}</span>
          </span>
          <span>
            <span className="text-muted-foreground">Suitability</span>{" "}
            <span
              className={
                m.suitability_score >= 7
                  ? "font-mono text-emerald-500"
                  : "font-mono text-amber-500"
              }
            >
              {m.suitability_score}/10
            </span>
          </span>
          <span>
            <span className="text-muted-foreground">Fingerprint</span>{" "}
            <span className="font-mono text-[10px]">{m.fingerprint}</span>
          </span>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card text-xs">
        <button
          onClick={() => setShowData((v) => !v)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted"
        >
          {showData ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronRight className="size-3.5" />
          )}
          <span className="font-medium">Underlying records</span>
          <span className="text-muted-foreground">
            ({result.records.length})
          </span>
          <span className="ml-auto text-muted-foreground">
            the source-of-truth the compute-answer pane queries
          </span>
        </button>
        {showData && result.records.length > 0 && (
          <div className="overflow-x-auto border-t border-border">
            <table className="w-full text-left">
              <thead className="bg-muted/40">
                <tr>
                  {Object.keys(result.records[0]).map((k) => (
                    <th
                      key={k}
                      className="px-3 py-1.5 font-semibold text-muted-foreground"
                    >
                      {k}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.records.map((row, i) => (
                  <tr key={i} className="border-t border-border/40">
                    {Object.keys(result.records[0]).map((k) => (
                      <td key={k} className="px-3 py-1 font-mono">
                        {String(row[k])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
