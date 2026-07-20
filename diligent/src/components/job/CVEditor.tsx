import { useEffect, useRef, useState } from "react";
import { Plus, Trash2, Save, Upload, LoaderCircle } from "lucide-react";
import { Button, Input, Textarea } from "@/components/ui";
import type { CVSection, ResumeDoc } from "@/types";
import {
  extractCvText,
  parseCvToResumeDoc,
  resumeDocToFlatSections,
  structureFlatCv,
} from "@/lib/functions";
import { useApp } from "@/contexts";
import { shouldUseManagedApi } from "@/lib/functions/managed-api";
import { CvExportPanel } from "./CvExportPanel";
import type { CvSavePayload } from "@/hooks/useJobWorkspace";

interface CVEditorProps {
  sections: CVSection[];
  resumeDoc?: ResumeDoc | null;
  /** True while the base CV is being fetched from the backend on startup. */
  loading?: boolean;
  /** Set when the DB load failed (no localStorage fallback). */
  loadError?: string | null;
  /** Retry the DB load. */
  onReload?: () => void;
  onSave: (payload: CvSavePayload) => void | Promise<void>;
  /** Called right after a successful upload/convert+parse to persist the
   *  structured doc to the DB. Awaited so save failures can be surfaced.
   *  Does NOT arm the auto-pipeline. */
  onPersistDoc?: (doc: ResumeDoc) => void | Promise<void>;
}

function makeId() {
  return `cv_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
}

export const CVEditor = ({
  sections: initialSections,
  resumeDoc: initialResumeDoc,
  loading = false,
  loadError = null,
  onReload,
  onSave,
  onPersistDoc,
}: CVEditorProps) => {
  const [sections, setSections] = useState<CVSection[]>(initialSections);
  // `dirty` = there are unsaved changes (enables the Save button). True after
  // both a fresh upload AND manual edits.
  const [dirty, setDirty] = useState(false);
  // `editedSinceUpload` = the user manually edited the flat bullets, which
  // invalidates the structured doc's experience/skills/projects fidelity.
  // Determines whether Save sends the structured doc or the flat fallback.
  const [editedSinceUpload, setEditedSinceUpload] = useState(false);

  // Structured snapshot of the last upload (or the workspace's saved doc).
  // Survives across user edits unchanged. On save: if NOT editedSinceUpload
  // this gets sent up as the canonical structured payload; otherwise we fall
  // back to the edited flat list (preserving manual edits, losing structure).
  const [resumeDoc, setResumeDoc] = useState<ResumeDoc | null>(
    initialResumeDoc ?? null
  );

  // Upload-flow state
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadPhase, setUploadPhase] =
    useState<"idle" | "extracting" | "parsing" | "done">("idle");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [streamStatus, setStreamStatus] = useState("");

  // Cloud-save state — the base CV is DB-backed now, so saves are async and
  // can fail visibly (no localStorage backstop).
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const { selectedAIProvider, allAiProviders } = useApp();

  // Sync from parent when the base CV arrives asynchronously (DB load) — but
  // never clobber unsaved edits.
  useEffect(() => {
    if (dirty) return;
    setSections(initialSections);
    setResumeDoc(initialResumeDoc ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSections, initialResumeDoc]);

  const update = (next: CVSection[]) => {
    setSections(next);
    setDirty(true);
    // A manual edit invalidates the structured doc — Save will now use flat.
    setEditedSinceUpload(true);
  };

  // Persist a parsed structured doc to the DB (via parent), surfacing errors.
  const persistDoc = async (doc: ResumeDoc) => {
    setSaving(true);
    setSaveError(null);
    try {
      await onPersistDoc?.(doc);
      setDirty(false); // saved to the cloud — nothing pending
    } catch (err) {
      setSaveError(
        `Couldn't save to the server: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setSaving(false);
    }
  };

  // --- upload + parse ---------------------------------------------------------

  const resolveProvider = () => {
    const id = selectedAIProvider.provider;
    if (id) return allAiProviders.find((p) => p.id === id);
    return (
      allAiProviders.find((p) => p.id === "deepseek") ||
      allAiProviders.find((p) => p.id === "openai") ||
      allAiProviders[0]
    );
  };

  const handleFilePick = () => {
    setUploadError(null);
    fileInputRef.current?.click();
  };

  // Convert the existing flat sections into a structured ResumeDoc without a
  // file upload. One-click upgrade for legacy data.
  const handleConvertExisting = async () => {
    if (sections.length === 0) return;
    setUploadError(null);
    setStreamStatus("");
    setUploadPhase("parsing");
    try {
      const useManaged = await shouldUseManagedApi();
      const provider = useManaged ? undefined : resolveProvider();
      const effectiveSelectedProvider = provider?.id
        ? { ...selectedAIProvider, provider: provider.id }
        : selectedAIProvider;

      const parsedDoc = await structureFlatCv(
        sections,
        provider,
        effectiveSelectedProvider,
        (chunk) => setStreamStatus((prev) => prev + chunk)
      );
      const derivedFlat = resumeDocToFlatSections(parsedDoc);
      setResumeDoc(parsedDoc);
      setSections(derivedFlat);
      setEditedSinceUpload(false);
      setUploadPhase("done");
      await persistDoc(parsedDoc);
    } catch (err) {
      console.error("[cv] convert existing CV failed:", err);
      setUploadPhase("idle");
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setStreamStatus("");
    }
  };

  const handleFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset the input so picking the same file twice in a row still fires.
    e.target.value = "";
    if (!file) return;

    setUploadError(null);
    setStreamStatus("");
    setUploadPhase("extracting");
    try {
      const text = await extractCvText(file);
      if (!text.trim()) {
        throw new Error(
          "Couldn't extract any text from the file. If it's a scanned PDF, try re-exporting it from your CV source with selectable text."
        );
      }

      setUploadPhase("parsing");
      const useManaged = await shouldUseManagedApi();
      const provider = useManaged ? undefined : resolveProvider();
      const effectiveSelectedProvider = provider?.id
        ? { ...selectedAIProvider, provider: provider.id }
        : selectedAIProvider;

      // Parse into the structured ResumeDoc shape — drives the templated
      // LaTeX export. The flat view derived for editor display is best-effort
      // and only used when the user manually edits bullets after upload.
      const parsedDoc = await parseCvToResumeDoc(
        text,
        provider,
        effectiveSelectedProvider,
        (chunk) => setStreamStatus((prev) => prev + chunk)
      );

      const derivedFlat = resumeDocToFlatSections(parsedDoc);
      if (derivedFlat.length === 0) {
        throw new Error(
          "The model returned no usable sections. The CV text was extracted but couldn't be structured — try saving as DOCX and uploading that, or paste content manually below."
        );
      }

      setResumeDoc(parsedDoc);
      setSections(derivedFlat);
      setEditedSinceUpload(false);
      setUploadPhase("done");

      // Auto-persist immediately — upload IS the save. Writes to the DB
      // (source of truth) so the doc survives across sessions and the
      // tailored export routes through the templated LaTeX path. persistDoc
      // clears `dirty` on success and surfaces any save error.
      await persistDoc(parsedDoc);
    } catch (err) {
      console.error("[cv] upload parse failed:", err);
      setUploadPhase("idle");
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setStreamStatus("");
    }
  };

  // --- manual edit (existing behaviour) --------------------------------------

  const addSection = () => {
    update([...sections, { id: makeId(), section: "New Section", bullets: [""] }]);
  };

  const removeSection = (id: string) => {
    update(sections.filter((s) => s.id !== id));
  };

  const updateSectionName = (id: string, name: string) => {
    update(sections.map((s) => (s.id === id ? { ...s, section: name } : s)));
  };

  const addBullet = (id: string) => {
    update(
      sections.map((s) => (s.id === id ? { ...s, bullets: [...s.bullets, ""] } : s))
    );
  };

  const updateBullet = (id: string, idx: number, value: string) => {
    update(
      sections.map((s) =>
        s.id === id
          ? { ...s, bullets: s.bullets.map((b, i) => (i === idx ? value : b)) }
          : s
      )
    );
  };

  const removeBullet = (id: string, idx: number) => {
    update(
      sections.map((s) =>
        s.id === id ? { ...s, bullets: s.bullets.filter((_, i) => i !== idx) } : s
      )
    );
  };

  // Edit a structured experience entry's title/company/dates in place. Writes
  // directly into `resumeDoc` (and re-derives the flat view for display) but
  // deliberately does NOT set `editedSinceUpload` — these field tweaks don't
  // invalidate the structured doc's fidelity, so Save still persists the doc
  // (now with the corrected values) instead of falling back to the lossy flat
  // list.
  const updateExperienceField = (
    idx: number,
    field: "role" | "company" | "start" | "end",
    value: string
  ) => {
    if (!resumeDoc) return;
    const nextDoc: ResumeDoc = {
      ...resumeDoc,
      experience: resumeDoc.experience.map((e, i) =>
        i === idx ? { ...e, [field]: value } : e
      ),
    };
    setResumeDoc(nextDoc);
    setSections(resumeDocToFlatSections(nextDoc));
    setDirty(true);
  };

  const handleSave = async () => {
    const cleaned = sections
      .map((s) => ({ ...s, bullets: s.bullets.filter((b) => b.trim()) }))
      .filter((s) => s.section.trim());

    // Prefer the structured doc if it's still intact (no manual edits since
    // upload). Edits invalidate the doc's experience/skills/projects
    // fidelity, so we fall back to the flat list to preserve actual content.
    setSaving(true);
    setSaveError(null);
    try {
      if (resumeDoc && !editedSinceUpload) {
        await onSave({ kind: "doc", doc: resumeDoc, flat: cleaned });
      } else {
        await onSave({ kind: "flat", sections: cleaned });
      }
      setDirty(false);
      setUploadPhase("idle");
    } catch (err) {
      setSaveError(
        `Couldn't save to the server: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setSaving(false);
    }
  };

  // --- render -----------------------------------------------------------------

  const isUploading = uploadPhase === "extracting" || uploadPhase === "parsing";
  const uploadingLabel =
    uploadPhase === "extracting"
      ? "Extracting text…"
      : uploadPhase === "parsing"
        ? "Structuring with AI…"
        : "";

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        Upload your CV (PDF or DOCX) and we'll structure it automatically. Your
        CV is stored in the cloud (the backend) — it loads automatically and
        persists across sessions and devices.
      </p>

      {/* Loading the base CV from the backend (source of truth). */}
      {loading && (
        <div className="flex items-center gap-2 rounded-lg border border-input/40 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          <LoaderCircle className="h-3 w-3 animate-spin" />
          Loading your CV from the cloud…
        </div>
      )}

      {/* DB load failed — no local fallback, so this is actionable. */}
      {loadError && !loading && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <span>{loadError}</span>
          {onReload && (
            <Button size="sm" variant="outline" onClick={onReload} className="text-xs shrink-0">
              Retry
            </Button>
          )}
        </div>
      )}

      {/* Cloud-save status. */}
      {saving && (
        <div className="flex items-center gap-2 rounded-lg border border-input/40 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          <LoaderCircle className="h-3 w-3 animate-spin" />
          Saving to the cloud…
        </div>
      )}
      {saveError && !saving && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {saveError}
        </div>
      )}

      {/* Export-readiness banner. The formatted (templated LaTeX) export only
          works when a STRUCTURED ResumeDoc exists. Sections shown without a
          doc means legacy flat data — the export will fall back to the
          static template, NOT reflect tailoring. */}
      {resumeDoc ? (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-600">
          ✓ Structured CV ready — exports use your formatted template and
          reflect tailored content.
        </div>
      ) : sections.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-600">
          <span>
            ⚠ This CV is in the old flat format (no structured data). Convert
            it once to enable formatted PDF export with your template +
            tailored bullets.
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={handleConvertExisting}
            disabled={isUploading}
            className="self-start text-xs"
          >
            {uploadPhase === "parsing" ? (
              <LoaderCircle className="h-3 w-3 animate-spin" />
            ) : null}
            Convert existing CV (no re-upload)
          </Button>
        </div>
      ) : null}

      {/* Upload row */}
      <div className="flex flex-col gap-2 rounded-xl border border-dashed border-input/60 bg-muted/20 p-3">
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={handleFilePick}
            disabled={isUploading}
            className="text-xs"
          >
            {isUploading ? (
              <LoaderCircle className="h-3 w-3 animate-spin" />
            ) : (
              <Upload className="h-3 w-3" />
            )}
            {isUploading ? uploadingLabel : "Upload CV (.pdf, .docx)"}
          </Button>
          {uploadPhase === "done" && (
            <span className="text-xs text-emerald-600">
              ✓ Parsed — review below, then Save CV to persist.
            </span>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          onChange={handleFileChosen}
          className="hidden"
        />
        {isUploading && streamStatus && (
          <p className="text-xs text-muted-foreground line-clamp-2">
            {streamStatus}
          </p>
        )}
        {uploadError && (
          <p className="text-xs text-destructive">{uploadError}</p>
        )}
      </div>

      {/* Action row — ALWAYS visible directly under the Upload card so users
          never have to scroll to find Save CV. */}
      <div className="flex items-center gap-2 rounded-xl bg-muted/30 px-3 py-2 border border-input/30">
        <Button size="sm" variant="outline" onClick={addSection}>
          <Plus className="h-3 w-3" />
          Add section
        </Button>
        <Button
          size="sm"
          onClick={handleSave}
          disabled={!dirty || sections.length === 0}
          className={dirty ? "ring-2 ring-primary/40" : ""}
        >
          <Save className="h-3 w-3" />
          {dirty ? "Save CV →" : "Saved"}
        </Button>
        {dirty && (
          <span className="text-xs text-muted-foreground">
            unsaved changes
          </span>
        )}
      </div>

      {sections.length === 0 && !isUploading && (
        <p className="text-xs text-muted-foreground italic">
          No sections yet. Upload a file above, or add sections manually below.
        </p>
      )}

      {/* Export the saved base CV — disabled while there are unsaved edits
          so users don't render a stale snapshot by mistake. Prefer the
          structured ResumeDoc when intact so the export routes through the
          templated LaTeX path (matches the original CV's layout). */}
      {sections.length > 0 && !dirty && (
        <CvExportPanel
          sections={sections}
          resumeDoc={resumeDoc ?? undefined}
          label="base-export"
        />
      )}

      {/* Structured experience dates — editable independently of the flat
          bullets. Only shown when a structured ResumeDoc with experience
          exists. Editing here keeps the structured doc canonical so the
          export reflects the new dates. */}
      {resumeDoc && resumeDoc.experience.length > 0 && (
        <div className="flex flex-col gap-2 rounded-xl border border-input/50 p-3">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Experience roles & dates
          </span>
          <p className="text-[11px] text-muted-foreground">
            Edit each role's title, company, and dates — saved into your
            structured CV so the exported PDF reflects them.
          </p>
          {resumeDoc.experience.map((e, idx) => (
            <div
              key={idx}
              className="flex flex-col gap-1.5 rounded-lg border border-input/40 p-2"
            >
              <div className="flex items-center gap-2">
                <Input
                  value={e.role}
                  onChange={(ev) =>
                    updateExperienceField(idx, "role", ev.target.value)
                  }
                  className="h-7 text-xs font-medium"
                  placeholder="Role title (e.g. Frontend Engineer)"
                />
                <span className="text-xs text-muted-foreground shrink-0">@</span>
                <Input
                  value={e.company}
                  onChange={(ev) =>
                    updateExperienceField(idx, "company", ev.target.value)
                  }
                  className="h-7 text-xs"
                  placeholder="Company"
                />
              </div>
              <div className="flex items-center gap-2">
                <Input
                  value={e.start}
                  onChange={(ev) =>
                    updateExperienceField(idx, "start", ev.target.value)
                  }
                  className="h-7 text-xs"
                  placeholder="Start (e.g. Oct. 2023)"
                />
                <span className="text-xs text-muted-foreground shrink-0">–</span>
                <Input
                  value={e.end}
                  onChange={(ev) =>
                    updateExperienceField(idx, "end", ev.target.value)
                  }
                  className="h-7 text-xs"
                  placeholder="End (e.g. Present)"
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Scrollable section list — sits BELOW the action row so Save is
          always reachable without scrolling. */}
      {sections.length > 0 && (
        <div className="flex flex-col gap-3 max-h-[50vh] overflow-y-auto pr-1">
          {sections.map((section) => (
            <div
              key={section.id}
              className="flex flex-col gap-2 rounded-xl border border-input/50 p-3"
            >
              <div className="flex items-center gap-2">
                <Input
                  value={section.section}
                  onChange={(e) => updateSectionName(section.id, e.target.value)}
                  className="h-7 text-xs font-semibold"
                  placeholder="Section name"
                />
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 shrink-0"
                  onClick={() => removeSection(section.id)}
                  title="Remove section"
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>

              {section.bullets.map((bullet, idx) => (
                <div key={idx} className="flex items-start gap-2">
                  <Textarea
                    value={bullet}
                    onChange={(e) => updateBullet(section.id, idx, e.target.value)}
                    placeholder="Bullet point…"
                    className="min-h-0 resize-none text-xs py-1.5"
                    rows={2}
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 mt-0.5 shrink-0"
                    onClick={() => removeBullet(section.id, idx)}
                    title="Remove bullet"
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))}

              <Button
                size="sm"
                variant="ghost"
                className="self-start text-xs h-7"
                onClick={() => addBullet(section.id)}
              >
                <Plus className="h-3 w-3" />
                Add bullet
              </Button>
            </div>
          ))}
        </div>
      )}

    </div>
  );
};
