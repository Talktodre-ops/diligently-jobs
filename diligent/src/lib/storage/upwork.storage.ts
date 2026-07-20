import { STORAGE_KEYS } from "@/config";
import { safeLocalStorage } from "./helper";
import type { UpworkWorkspace } from "@/types";

export function loadUpworkWorkspaces(): UpworkWorkspace[] {
  try {
    const saved = safeLocalStorage.getItem(STORAGE_KEYS.UPWORK_WORKSPACES);
    if (!saved) return [];
    const parsed = JSON.parse(saved);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveUpworkWorkspace(ws: UpworkWorkspace): void {
  try {
    const workspaces = loadUpworkWorkspaces();
    const idx = workspaces.findIndex((w) => w.id === ws.id);
    if (idx >= 0) {
      workspaces[idx] = ws;
    } else {
      workspaces.push(ws);
    }
    safeLocalStorage.setItem(
      STORAGE_KEYS.UPWORK_WORKSPACES,
      JSON.stringify(workspaces)
    );
  } catch {
    // silent
  }
}

export function deleteUpworkWorkspace(id: string): void {
  try {
    const workspaces = loadUpworkWorkspaces().filter((w) => w.id !== id);
    safeLocalStorage.setItem(
      STORAGE_KEYS.UPWORK_WORKSPACES,
      JSON.stringify(workspaces)
    );
  } catch {
    // silent
  }
}
