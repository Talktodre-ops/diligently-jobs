import { useEffect, useRef, useState } from "react";
import { Download, FileText, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui";
import {
  createCoverLetter,
  enqueueCoverLetterRender,
  presignDownload,
  waitForJob,
} from "@/lib/backend";
import type { CvRenderResult } from "@/lib/backend/types";
import type { CoverLetterDoc, ResearchSource } from "@/types";

interface CoverLetterExportPanelProps {
  doc: CoverLetterDoc;
  sources: ResearchSource[];
  /** Required to persist + render — the backend keys the row to an application. */
  applicationId?: string;
}

type Phase =
  | { kind: "idle" }
  | { kind: "snapshotting" }
  | { kind: "enqueueing" }
  | { kind: "rendering"; jobId: string }
  | { kind: "presigning" }
  | {
      kind: "ready";
      pdfInlineUrl: string;
      pdfDownloadUrl: string;
      docxDownloadUrl: string;
    }
  | { kind: "error"; message: string };

/**
 * Async cover-letter export: persist a cover_letters row → enqueue render →
 * poll → presign → preview PDF + download links. Mirrors CvExportPanel.
 */
export const CoverLetterExportPanel = ({
  doc,
  sources,
  applicationId,
}: CoverLetterExportPanelProps) => {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const aborted = useRef(false);

  useEffect(() => {
    aborted.current = false;
    return () => {
      aborted.current = true;
    };
  }, []);

  const isWorking =
    phase.kind === "snapshotting" ||
    phase.kind === "enqueueing" ||
    phase.kind === "rendering" ||
    phase.kind === "presigning";

  if (!applicationId) {
    return (
      <div className="rounded-xl border border-dashed border-input/50 bg-muted/20 p-3 text-xs text-muted-foreground">
        Export needs a synced application. Parse the JD while the backend is
        reachable (tab 1), then come back to export the letter as PDF/DOCX.
      </div>
    );
  }

  const handleExport = async () => {
    setPhase({ kind: "snapshotting" });
    try {
      const body = doc.paragraphs.join("\n\n");
      const cl = await createCoverLetter(applicationId, { body, doc, sources });
      if (aborted.current) return;

      setPhase({ kind: "enqueueing" });
      const enq = await enqueueCoverLetterRender(cl.id);
      if (aborted.current) return;

      setPhase({ kind: "rendering", jobId: enq.job_id });
      const job = await waitForJob(enq.job_id, { intervalMs: 800, timeoutMs: 60_000 });
      if (aborted.current) return;

      const result = job.result as unknown as CvRenderResult | null;
      if (!result?.pdf_key || !result?.docx_key) {
        throw new Error("Render finished but didn't return file keys");
      }

      setPhase({ kind: "presigning" });
      const [pdfInline, pdfDl, docxDl] = await Promise.all([
        presignDownload(result.pdf_key, 600),
        presignDownload(result.pdf_key, 600, 'attachment; filename="Cover-Letter.pdf"'),
        presignDownload(result.docx_key, 600, 'attachment; filename="Cover-Letter.docx"'),
      ]);
      if (aborted.current) return;

      setPhase({
        kind: "ready",
        pdfInlineUrl: pdfInline.url,
        pdfDownloadUrl: pdfDl.url,
        docxDownloadUrl: docxDl.url,
      });
    } catch (err) {
      if (aborted.current) return;
      setPhase({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const statusText = (() => {
    switch (phase.kind) {
      case "snapshotting":
        return "Saving letter…";
      case "enqueueing":
        return "Submitting render…";
      case "rendering":
        return "Rendering PDF + DOCX…";
      case "presigning":
        return "Preparing downloads…";
      default:
        return null;
    }
  })();

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-input/50 bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <FileText className="h-3 w-3 text-muted-foreground" />
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Export
          </span>
        </div>
        <Button size="sm" onClick={handleExport} disabled={isWorking} className="text-xs">
          {isWorking ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              {statusText}
            </>
          ) : phase.kind === "ready" ? (
            <>
              <RefreshCw className="h-3 w-3" />
              Re-render
            </>
          ) : (
            <>
              <FileText className="h-3 w-3" />
              Generate PDF + DOCX
            </>
          )}
        </Button>
      </div>

      {phase.kind === "error" && (
        <p className="text-xs text-destructive">{phase.message}</p>
      )}

      {phase.kind === "ready" && (
        <>
          <div className="flex items-center gap-2">
            <Button asChild size="sm" variant="outline" className="text-xs">
              <a href={phase.pdfDownloadUrl} download>
                <Download className="h-3 w-3" />
                Download PDF
              </a>
            </Button>
            <Button asChild size="sm" variant="outline" className="text-xs">
              <a href={phase.docxDownloadUrl} download>
                <Download className="h-3 w-3" />
                Download DOCX
              </a>
            </Button>
          </div>
          <iframe
            key={phase.pdfInlineUrl}
            src={phase.pdfInlineUrl}
            title="Cover letter preview"
            className="w-full rounded-lg border border-input/50 bg-white"
            style={{ height: "60vh" }}
          />
        </>
      )}
    </div>
  );
};
