import { STORAGE_KEYS } from "@/config";
import { safeLocalStorage } from "./helper";
import type { JobWorkspace } from "@/types";

export function loadWorkspaces(): JobWorkspace[] {
  try {
    const saved = safeLocalStorage.getItem(STORAGE_KEYS.JOB_WORKSPACES);
    if (!saved) return [];
    const parsed = JSON.parse(saved);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveWorkspace(ws: JobWorkspace): void {
  try {
    const workspaces = loadWorkspaces();
    const idx = workspaces.findIndex((w) => w.id === ws.id);
    if (idx >= 0) {
      workspaces[idx] = ws;
    } else {
      workspaces.push(ws);
    }
    safeLocalStorage.setItem(
      STORAGE_KEYS.JOB_WORKSPACES,
      JSON.stringify(workspaces)
    );
  } catch {
    // silent
  }
}

export function deleteWorkspace(id: string): void {
  try {
    const workspaces = loadWorkspaces().filter((w) => w.id !== id);
    safeLocalStorage.setItem(
      STORAGE_KEYS.JOB_WORKSPACES,
      JSON.stringify(workspaces)
    );
  } catch {
    // silent
  }
}

// Base CV persistence moved to the backend DB (single source of truth).
// See useJobWorkspace: loadBaseCvFromDb / persistBaseCVDoc / updateBaseCV.
// Previously cached here in localStorage (BASE_CV / BASE_CV_DOC) — removed
// to eliminate the dual-store ambiguity between localStorage and the DB.
