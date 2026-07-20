import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertCircleIcon, CheckIcon, InfoIcon, XIcon } from "lucide-react";

/**
 * Lightweight toast system. Replaces scattered `console.warn` / silent
 * `setError` calls so users actually see when something fails. Rate-limited
 * (default 3s dedupe by `key`) so a stream of identical errors doesn't
 * spam the UI.
 *
 * Usage:
 *   const toast = useToast();
 *   toast.error("Failed to upload", { key: "audio-upload" });
 *   toast.success("Saved");
 */

type ToastKind = "error" | "warn" | "info" | "success";

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  /** Auto-dismiss after this many ms. 0 = manual dismiss only. */
  ttl: number;
}

interface ToastApi {
  error(msg: string, opts?: { key?: string; ttl?: number }): void;
  warn(msg: string, opts?: { key?: string; ttl?: number }): void;
  info(msg: string, opts?: { key?: string; ttl?: number }): void;
  success(msg: string, opts?: { key?: string; ttl?: number }): void;
  dismiss(id: number): void;
}

const ToastCtx = createContext<ToastApi | null>(null);

const DEFAULT_TTL: Record<ToastKind, number> = {
  error: 8000,
  warn: 6000,
  info: 4000,
  success: 3000,
};

const DEDUPE_WINDOW_MS = 3000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idRef = useRef(1);
  // Track last-shown timestamp per dedupe key so spam doesn't pile up.
  const recentRef = useRef<Map<string, number>>(new Map());

  const dismiss = useCallback((id: number) => {
    setToasts((cur) => cur.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string, opts?: { key?: string; ttl?: number }) => {
      if (opts?.key) {
        const now = Date.now();
        const last = recentRef.current.get(opts.key) ?? 0;
        if (now - last < DEDUPE_WINDOW_MS) return;
        recentRef.current.set(opts.key, now);
      }

      const id = idRef.current++;
      const ttl = opts?.ttl ?? DEFAULT_TTL[kind];
      setToasts((cur) => [...cur, { id, kind, message, ttl }]);
      if (ttl > 0) {
        window.setTimeout(() => dismiss(id), ttl);
      }
    },
    [dismiss]
  );

  const api: ToastApi = {
    error: (m, o) => push("error", m, o),
    warn: (m, o) => push("warn", m, o),
    info: (m, o) => push("info", m, o),
    success: (m, o) => push("success", m, o),
    dismiss,
  };

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastCtx.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) {
    // Fallback for components rendered before the provider mounts —
    // logs but doesn't crash, so adding new toast calls is safe even in
    // places where the context isn't wired yet.
    return {
      error: (m) => console.error("[toast]", m),
      warn: (m) => console.warn("[toast]", m),
      info: (m) => console.info("[toast]", m),
      success: (m) => console.log("[toast]", m),
      dismiss: () => {},
    };
  }
  return ctx;
}

const KIND_STYLES: Record<ToastKind, string> = {
  error: "bg-red-500 text-white",
  warn: "bg-amber-500 text-white",
  info: "bg-blue-500 text-white",
  success: "bg-emerald-500 text-white",
};

const KIND_ICONS: Record<ToastKind, ReactNode> = {
  error: <AlertCircleIcon className="h-4 w-4 flex-shrink-0" />,
  warn: <AlertCircleIcon className="h-4 w-4 flex-shrink-0" />,
  info: <InfoIcon className="h-4 w-4 flex-shrink-0" />,
  success: <CheckIcon className="h-4 w-4 flex-shrink-0" />,
};

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}) {
  // Cap to last 4 visible — anything earlier is gone.
  const visible = toasts.slice(-4);
  if (visible.length === 0) return null;
  return (
    <div
      className="fixed bottom-2 right-2 z-[100] flex flex-col gap-2 pointer-events-none"
      style={{ maxWidth: "min(420px, 90vw)" }}
    >
      {visible.map((t) => (
        <div
          key={t.id}
          className={`flex items-start gap-2 rounded-md px-3 py-2 shadow-lg text-xs pointer-events-auto ${KIND_STYLES[t.kind]}`}
        >
          {KIND_ICONS[t.kind]}
          <span className="flex-1 leading-relaxed break-words">{t.message}</span>
          <button
            type="button"
            onClick={() => onDismiss(t.id)}
            className="opacity-70 hover:opacity-100"
            title="Dismiss"
          >
            <XIcon className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * Hook into a global Tauri event so Rust-side warnings can also surface
 * here. Use sparingly — Rust paths emitting toast events should be for
 * conditions the user actually needs to see (config errors, permission
 * denials), not chatty debugging.
 */
export function useGlobalToastListeners() {
  const toast = useToast();
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let unShortcut: (() => void) | undefined;

    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<{
        kind: ToastKind;
        message: string;
        key?: string;
      }>("toast", (event) => {
        const { kind, message, key } = event.payload;
        toast[kind](message, key ? { key } : undefined);
      });

      unShortcut = await listen<{ failed: string[] }>(
        "shortcut-conflict",
        (event) => {
          const failed = event.payload?.failed ?? [];
          if (failed.length === 0) return;
          toast.warn(
            `Hotkey conflict — these failed to register: ${failed.join(
              ", "
            )}. Another app already owns them. (See Settings → System health.)`,
            { key: "shortcut-conflict" }
          );
        }
      );
    })();

    return () => {
      unlisten?.();
      unShortcut?.();
    };
  }, [toast]);
}
