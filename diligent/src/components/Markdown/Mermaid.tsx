import { useEffect, useId, useState } from "react";

/**
 * Light auto-repair for the most common Mermaid syntax slips the LLM makes.
 * None of these change the meaning of valid input; they only insert
 * whitespace where Sonnet sometimes elides it.
 *
 *   - `]identifier`     → `]\n  identifier`   (closing bracket touching next node)
 *   - `)identifier`     → `)\n  identifier`   (closing paren touching next node)
 *   - `]-->`            → `] -->`              (arrow stuck to node bracket)
 *   - `)-->`            → `) -->`              (arrow stuck to cylinder bracket)
 *   - `--><`            → `--> <`              (degenerate edge)
 */
function repairMermaid(code: string): string {
  return code
    .replace(/](?=[A-Za-z_])/g, "]\n  ")
    .replace(/\)(?=[A-Za-z_])/g, ")\n  ")
    .replace(/](?=--)/g, "] ")
    .replace(/\)(?=--)/g, ") ")
    .replace(/-->(?=[A-Za-z_])/g, "--> ");
}

/**
 * Renders a Mermaid diagram inline. Used by the Markdown component when it
 * encounters a ```mermaid fenced block — the system-design prompt asks Claude
 * to emit architecture diagrams in this format.
 *
 * IMPORTANT: this component must never pass BOTH `dangerouslySetInnerHTML`
 * and `children` to the same element. React throws in commit if you do
 * (even if children is conditionally `false`/`null`), and an uncaught
 * commit-phase error unmounts the whole React tree — which is why an
 * earlier version made the app appear to "crash" mid-stream when the
 * mermaid block first started rendering.
 */
export const MermaidBlock = ({ code }: { code: string }) => {
  const reactId = useId();
  const safeId = `mermaid-${reactId.replace(/[^a-zA-Z0-9]/g, "")}`;
  const [error, setError] = useState<string | null>(null);
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    // Skip empty / clearly-partial blocks while streaming. The block has to
    // be at least a couple of lines for Mermaid to even attempt parsing.
    if (!code.trim() || code.trim().split("\n").length < 2) {
      setSvg(null);
      setError(null);
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
          // useMaxWidth: false stops Mermaid from emitting an inline
          // `style="max-width: 100%"` that caps the SVG at the container
          // width — letting our CSS w-[1500px] override actually take
          // effect so small diagrams scale UP, not shrink to fit the box.
          flowchart: { curve: "basis", htmlLabels: true, useMaxWidth: false },
          sequence: { showSequenceNumbers: false, useMaxWidth: false },
          // Bigger base font for labels — readability over compactness.
          themeVariables: {
            fontSize: "18px",
            primaryColor: "#f5f4ed",
            primaryTextColor: "#1a1a1a",
            primaryBorderColor: "#1B365D",
            lineColor: "#1B365D",
          },
        });

        // Try the original code first. If it fails parse, try the
        // auto-repaired version — Sonnet sometimes elides whitespace
        // between tokens, which the repair function inserts back.
        let attempt = code;
        try {
          await mermaid.parse(attempt, { suppressErrors: false });
        } catch {
          attempt = repairMermaid(code);
          await mermaid.parse(attempt, { suppressErrors: false });
        }

        const { svg } = await mermaid.render(safeId, attempt);
        if (!cancelled) {
          setSvg(svg);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, safeId]);

  // Three exclusive render paths — none of them pass both
  // dangerouslySetInnerHTML and children to the same element.

  if (error) {
    return (
      <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 my-2">
        <p className="text-xs font-semibold text-amber-700 dark:text-amber-400 mb-1">
          Diagram failed to render
        </p>
        <p className="text-xs text-amber-700 dark:text-amber-400 mb-2 break-words">
          {error}
        </p>
        <pre className="text-xs font-mono whitespace-pre-wrap text-foreground/80">
          {code}
        </pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="my-3 rounded-md border border-input/40 bg-background/40 p-3">
        <p className="text-xs text-muted-foreground italic">
          Rendering diagram…
        </p>
      </div>
    );
  }

  return (
    <div
      className="
        my-3 rounded-md border border-input/40 bg-background/40 p-3
        w-full max-w-full min-w-0
        overflow-x-auto
        [&_svg]:!max-w-none
        [&_svg]:!w-[1000px]
        [&_svg]:!h-auto
        [&_svg_.label]:!font-medium
      "
      style={{
        // Force a comfortable minimum readable size. Mermaid normally caps
        // SVG width at the container, which collapses small diagrams to
        // ~200px and makes labels unreadable. We override with min-width
        // 100% + min-height 420px; complex diagrams overflow horizontally
        // and scroll, which the user explicitly OK'd.
        WebkitTextStrokeWidth: 0,
      }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
};
