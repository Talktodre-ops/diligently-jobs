import { useEffect, useId, useState } from "react";
import { Loader2, Image as ImageIcon, Download, Copy, Check } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";

/**
 * Light auto-repair for the most common Mermaid syntax slips LLMs make — same
 * spirit as Markdown/Mermaid.tsx. Only inserts whitespace; never changes meaning.
 */
function repairMermaid(code: string): string {
  return code
    .replace(/](?=[A-Za-z_])/g, "]\n  ")
    .replace(/\)(?=[A-Za-z_])/g, ")\n  ")
    .replace(/](?=--)/g, "] ")
    .replace(/\)(?=--)/g, ") ")
    .replace(/-->(?=[A-Za-z_])/g, "--> ");
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Rewrite any <foreignObject> (HTML-in-SVG, which Mermaid uses for some labels
 * even with htmlLabels:false) into plain SVG <text>. This makes the SVG fully
 * self-contained so it rasterizes to PNG without tainting the export canvas.
 * No-op when there are no foreignObjects. Returns the original string on any
 * parse failure.
 */
function inlineForeignObjects(svg: string): string {
  try {
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    if (doc.querySelector("parsererror")) return svg;
    const fos = Array.from(doc.querySelectorAll("foreignObject"));
    if (fos.length === 0) return svg;

    for (const fo of fos) {
      const raw = (fo.textContent || "").replace(/\s+/g, " ").trim();
      const x = parseFloat(fo.getAttribute("x") || "0");
      const y = parseFloat(fo.getAttribute("y") || "0");
      const w = parseFloat(fo.getAttribute("width") || "0");
      const h = parseFloat(fo.getAttribute("height") || "0");

      const text = doc.createElementNS(SVG_NS, "text");
      text.setAttribute("x", String(x + w / 2));
      text.setAttribute("y", String(y + h / 2));
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("dominant-baseline", "middle");
      text.setAttribute("font-family", "ui-sans-serif, system-ui, sans-serif");
      text.setAttribute("font-size", "14");
      text.setAttribute("fill", "#1a1a1a");
      text.textContent = raw;

      fo.parentNode?.replaceChild(text, fo);
    }
    return new XMLSerializer().serializeToString(doc.documentElement);
  } catch {
    return svg;
  }
}

/** Parse intrinsic width/height from an SVG string (width/height attrs, else viewBox). */
function svgDimensions(svg: string): { w: number; h: number } {
  const wMatch = svg.match(/<svg[^>]*\bwidth="([\d.]+)/i);
  const hMatch = svg.match(/<svg[^>]*\bheight="([\d.]+)/i);
  let w = wMatch ? parseFloat(wMatch[1]) : 0;
  let h = hMatch ? parseFloat(hMatch[1]) : 0;
  if (!w || !h) {
    const vb = svg.match(/viewBox="[\d.\-]+\s+[\d.\-]+\s+([\d.]+)\s+([\d.]+)"/i);
    if (vb) {
      w = parseFloat(vb[1]);
      h = parseFloat(vb[2]);
    }
  }
  if (!w || !h) {
    w = 1200;
    h = 800;
  }
  return { w, h };
}

/** Rasterize an SVG string to a PNG Blob (white background, 2× for crispness).
 *  Throws "FOREIGN_OBJECT" when the SVG embeds HTML (foreignObject) — that taints
 *  the export canvas, so the caller should fall back to an SVG download. */
async function svgToPng(svg: string, scale = 2): Promise<Blob> {
  // HTML-in-SVG (foreignObject) makes the canvas "tainted" → toBlob throws.
  // Bail early so the caller can fall back cleanly instead of erroring.
  if (/<foreignObject/i.test(svg)) {
    throw new Error("FOREIGN_OBJECT");
  }
  // Strip external @import font refs — loading them taints the canvas too.
  const clean = svg.replace(/@import\s+url\([^)]*\)\s*;?/gi, "");
  const { w, h } = svgDimensions(clean);
  const blob = new Blob([clean], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.width = w;
    img.height = h;
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Failed to load SVG for PNG export"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(w * scale);
    canvas.height = Math.ceil(h * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D not available");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("PNG encode failed"))),
        "image/png"
      )
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000; // chunk to stay under the apply/spread arg limit
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Save bytes to the user's Downloads folder via the Rust `save_file_to_downloads`
 * command. WebView2 silently drops programmatic blob/anchor downloads, so we
 * hand the bytes to Rust. Returns the saved file path.
 */
async function saveToDownloads(
  data: Blob | string,
  filename: string
): Promise<string> {
  const bytes =
    typeof data === "string"
      ? new TextEncoder().encode(data)
      : new Uint8Array(await data.arrayBuffer());
  return invoke<string>("save_file_to_downloads", {
    filename,
    base64Data: bytesToBase64(bytes),
  });
}

/**
 * Renders the proposal's architecture diagram and offers downloads. Renders with
 * htmlLabels:false so the SVG is self-contained (no foreignObject) — which keeps
 * the canvas untainted so the PNG export works. What you preview is exactly what
 * downloads.
 */
export const ArchitectureDiagram = ({ code }: { code: string }) => {
  const reactId = useId();
  const safeId = `arch-${reactId.replace(/[^a-zA-Z0-9]/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const { isCopied, handleCopy } = useCopyToClipboard({ text: code });

  useEffect(() => {
    if (!code.trim()) {
      setSvg(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: "default",
          securityLevel: "loose",
          fontFamily: "ui-sans-serif, system-ui",
          // htmlLabels:false → SVG <text> labels (no foreignObject), so the
          // rendered SVG rasterizes to PNG without tainting the canvas.
          flowchart: { curve: "basis", htmlLabels: false, useMaxWidth: false },
          themeVariables: {
            fontSize: "16px",
            primaryColor: "#f5f4ed",
            primaryTextColor: "#1a1a1a",
            primaryBorderColor: "#1B365D",
            lineColor: "#1B365D",
          },
        });

        let attempt = code;
        try {
          await mermaid.parse(attempt, { suppressErrors: false });
        } catch {
          attempt = repairMermaid(code);
          await mermaid.parse(attempt, { suppressErrors: false });
        }
        const { svg } = await mermaid.render(safeId, attempt);
        // Inline any foreignObject labels → pure SVG, so PNG export never taints.
        const clean = inlineForeignObjects(svg);
        if (!cancelled) {
          setSvg(clean);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, safeId]);

  const onDownloadPng = async () => {
    if (!svg) return;
    setExporting(true);
    setNote(null);
    setSaved(null);
    try {
      const png = await svgToPng(svg, 2);
      const path = await saveToDownloads(png, "architecture-diagram.png");
      setSaved(path);
    } catch {
      // PNG raster blocked (tainted canvas / foreignObject). Fall back to SVG —
      // vector, also attachable on Upwork, and never destroys the diagram view.
      try {
        const path = await saveToDownloads(svg, "architecture-diagram.svg");
        setSaved(path);
        setNote(
          "PNG export wasn't possible for this diagram, so I saved an SVG instead — it's vector, attaches fine to Upwork, and opens in any browser (where you can also “Save as PNG”)."
        );
      } catch (e) {
        setNote(
          e instanceof Error ? `Couldn't save the file: ${e.message}` : "Couldn't save the file."
        );
      }
    } finally {
      setExporting(false);
    }
  };

  const onDownloadSvg = async () => {
    if (!svg) return;
    setNote(null);
    setSaved(null);
    try {
      const path = await saveToDownloads(svg, "architecture-diagram.svg");
      setSaved(path);
    } catch (e) {
      setNote(
        e instanceof Error ? `Couldn't save the file: ${e.message}` : "Couldn't save the file."
      );
    }
  };

  if (error) {
    return (
      <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
        <p className="text-xs font-semibold text-amber-700 mb-1">
          Diagram failed to render
        </p>
        <p className="text-xs text-amber-700 mb-2 break-words">{error}</p>
        <pre className="text-[10px] font-mono whitespace-pre-wrap text-foreground/80">
          {code}
        </pre>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        <Button
          size="sm"
          onClick={onDownloadPng}
          disabled={!svg || exporting}
          className="text-xs"
        >
          {exporting ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <ImageIcon className="h-3 w-3" />
          )}
          Download PNG
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={onDownloadSvg}
          disabled={!svg}
          className="text-xs h-7"
        >
          <Download className="h-3 w-3" />
          SVG
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={handleCopy}
          className="text-xs h-7"
        >
          {isCopied ? (
            <>
              <Check className="h-3 w-3 text-emerald-500" />
              Copied
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" />
              Copy Mermaid
            </>
          )}
        </Button>
      </div>

      {saved && (
        <p className="text-[11px] text-emerald-600 leading-relaxed break-all">
          Saved to your Downloads folder: {saved}
        </p>
      )}

      {note && (
        <p className="text-[11px] text-amber-600 leading-relaxed">{note}</p>
      )}

      {!svg ? (
        <div className="rounded-md border border-input/40 bg-background/40 p-3">
          <p className="text-xs text-muted-foreground italic">Rendering diagram…</p>
        </div>
      ) : (
        <>
          {/* Preview is scaled to fit the window; downloads are full resolution. */}
          <div
            className="
              rounded-md border border-input/40 bg-white p-2
              w-full max-w-full min-w-0 max-h-[55vh] overflow-auto
              [&_svg]:!max-w-full [&_svg]:!w-auto [&_svg]:!h-auto
            "
            dangerouslySetInnerHTML={{ __html: svg }}
          />
          <p className="text-[10px] text-muted-foreground">
            Preview is scaled to fit — the downloaded file is full resolution.
          </p>
        </>
      )}
    </div>
  );
};
