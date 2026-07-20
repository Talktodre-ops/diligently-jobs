import { safeLocalStorage } from "../storage";
import { STORAGE_KEYS } from "@/config";

// Managed-API mode = the optional cloud backend for STT/LLM (Postgres + R2 sync,
// Deepgram WebSocket, etc.). Off by default — local BYOK works without it.
export async function shouldUseManagedApi(): Promise<boolean> {
  try {
    const value = safeLocalStorage.getItem(STORAGE_KEYS.MANAGED_API_ENABLED);
    return value === "true";
  } catch (error) {
    console.warn("Failed to check managed API availability:", error);
    return false;
  }
}
