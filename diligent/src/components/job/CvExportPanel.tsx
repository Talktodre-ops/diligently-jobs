import { useEffect, useRef, useState } from "react";
import { Download, FileText, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui";
import {
  appendEvent,
  createCvVersion,
  enqueueCvRender,
  presignDownload,
  waitForJob,
} from "@/lib/backend";
import type { CvRenderResult } from "@/lib/backend/types";
import type { CVSection, ResumeDoc } from "@/types";

interface CvExportPanelProps {
  /** Flat sections to snapshot + render. Empty array disables the Export
   *  button when no `resumeDoc` is provided. */
  sections: CVSection[];
  /** Structured CV. When present, this is what gets sent to the backend so
   *  the render routes through the templated LaTeX path (preserves the
   *  user's original layout). Falls back to `sections` if absent. */
  resumeDoc?: ResumeDoc;
  /** Optional — if set, the rendered cv_versions row is tied to this app. */
  applicationId?: string;
  /** Stored on the cv_versions row; helps later filtering. */
  label?: string;
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
      result: CvRenderResult;
    }
  | { kind: "error"; message: string };

/**
 * Async CV export workflow.
 *
 *   click → snapshot a cv_versions row → enqueue render job → poll → presign
 *   → render PDF inline (iframe) + expose Download PDF / DOCX buttons.
 *
 * Every click creates a *new* cv_versions row (immutable snapshots). The
 * backend handles dedupe of in-flight render jobs for the same CV id, but
 * each click here is a deliberate new pin point.
 */
export const CvExportPanel = ({
  sections,
  resumeDoc,
  applicationId,
  label,
}: CvExportPanelProps) => {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const aborted = useRef(false);

  useEffect(() => {
    // Reset on (re)mount. Without this line, React.StrictMode's dev-only
    // mount → cleanup → remount sequence leaves `aborted.current === true`
    // because useRef values survive the double-mount but the cleanup runs
    // in between. Every async step in handleExport then silently bails.
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

  const canExport = (sections.length > 0 || !!resumeDoc) && !isWorking;

  const handleExport = async () => {
    setPhase({ kind: "snapshotting" });
    try {
      // 1. Snapshot as an immutable cv_versions row. Prefer the structured
      // ResumeDoc so the render routes through the templated LaTeX path; fall
      // back to flat sections if no doc is available (legacy render path
      // produces the user's static template).
      const sectionsPayload: unknown = resumeDoc ?? sections;
      const cv = await createCvVersion({
        application_id: applicationId ?? null,
        sections: sectionsPayload as never,
        label: label ?? "export",
      });
      if (aborted.current) return;

      // 2. Enqueue async render — returns immediately.
      setPhase({ kind: "enqueueing" });
      const enq = await enqueueCvRender(cv.id);
      if (aborted.current) return;

      // 3. Poll until done. Renders typically take ~1-3s.
      setPhase({ kind: "rendering", jobId: enq.job_id });
      const job = await waitForJob(enq.job_id, {
        intervalMs: 800,
        timeoutMs: 60_000,
      });
      if (aborted.current) return;

      const result = job.result as unknown as CvRenderResult | null;
      if (!result?.pdf_key || !result?.docx_key) {
        throw new Error("Render finished but didn't return file keys");
      }

      // 4. Presign URLs: one inline (iframe preview) + two attachment
      //    (force a real download instead of opening the PDF viewer / print).
      setPhase({ kind: "presigning" });
      const [pdfInline, pdfDl, docxDl] = await Promise.all([
        presignDownload(result.pdf_key, 600),
        presignDownload(result.pdf_key, 600, 'attachment; filename="CV.pdf"'),
        presignDownload(result.docx_key, 600, 'attachment; filename="CV.docx"'),
      ]);
      if (aborted.current) return;

      setPhase({
        kind: "ready",
        pdfInlineUrl: pdfInline.url,
        pdfDownloadUrl: pdfDl.url,
        docxDownloadUrl: docxDl.url,
        result,
      });

      // Audit-log the export from the desktop's perspective. The backend
      // already emits `cv_rendered` server-side; this captures the user
      // intent (clicked Export here, not just an automatic re-render).
      appendEvent({
        kind: "cv_export_clicked",
        application_id: applicationId ?? null,
        payload: {
          cv_version_id: result.cv_version_id,
          pdf_key: result.pdf_key,
          docx_key: result.docx_key,
        },
      }).catch(() => {});
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
        return "Snapshotting CV…";
      case "enqueueing":
        return "Submitting render job…";
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
        <Button
          size="sm"
          onClick={handleExport}
          disabled={!canExport}
          className="text-xs"
        >
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
            <Button
              asChild
              size="sm"
              variant="outline"
              className="text-xs"
            >
              <a href={phase.pdfDownloadUrl} download>
                <Download className="h-3 w-3" />
                Download PDF
              </a>
            </Button>
            <Button
              asChild
              size="sm"
              variant="outline"
              className="text-xs"
            >
              <a href={phase.docxDownloadUrl} download>
                <Download className="h-3 w-3" />
                Download DOCX
              </a>
            </Button>
            <span className="text-xs text-muted-foreground">
              ATS-friendly DOCX, designed PDF
            </span>
          </div>

          {/* Inline preview — uses the inline-disposition URL so it renders in
              the webview; the download buttons use attachment URLs. */}
          <iframe
            key={phase.pdfInlineUrl}
            src={phase.pdfInlineUrl}
            title="CV preview"
            className="w-full rounded-lg border border-input/50 bg-white"
            style={{ height: "60vh" }}
          />
        </>
      )}
    </div>
  );
};
