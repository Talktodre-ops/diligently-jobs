import { useEffect, useState } from "react";
import { flushEventQueue, getHealth, queueSize } from "@/lib/backend";

const POLL_INTERVAL_MS = 30_000;

export interface BackendHealthSnapshot {
  /** true when last /health probe returned 2xx with postgres + r2 both ok */
  healthy: boolean;
  /** Postgres component sub-status; null while still loading. */
  postgresOk: boolean | null;
  /** R2 component sub-status; null while still loading. */
  r2Ok: boolean | null;
  /** Timestamp of the last successful probe; null until the first one lands. */
  lastChecked: Date | null;
  /** Optional failure reason from the last failed probe. */
  lastError: string | null;
  /** Number of events still buffered locally awaiting flush. */
  pendingEvents: number;
}

/**
 * Periodically pings the backend's `/health` endpoint and surfaces a
 * compact status view for the UI. Also drains the offline event queue
 * after every successful health probe — opportunistic catch-up.
 */
export function useBackendHealth(): BackendHealthSnapshot {
  const [snap, setSnap] = useState<BackendHealthSnapshot>({
    healthy: false,
    postgresOk: null,
    r2Ok: null,
    lastChecked: null,
    lastError: null,
    pendingEvents: queueSize(),
  });

  useEffect(() => {
    let cancelled = false;

    async function probe() {
      try {
        const body = await getHealth();
        if (cancelled) return;
        const healthy = body.postgres.ok && body.r2.ok;
        setSnap({
          healthy,
          postgresOk: body.postgres.ok,
          r2Ok: body.r2.ok,
          lastChecked: new Date(),
          lastError:
            !body.postgres.ok || !body.r2.ok
              ? `pg=${body.postgres.ok ? "ok" : body.postgres.detail ?? "fail"}; r2=${
                  body.r2.ok ? "ok" : body.r2.detail ?? "fail"
                }`
              : null,
          pendingEvents: queueSize(),
        });
        if (healthy) {
          // Opportunistic queue drain. Errors here are silent — the next probe
          // will retry.
          flushEventQueue()
            .then(() => {
              if (!cancelled) {
                setSnap((s) => ({ ...s, pendingEvents: queueSize() }));
              }
            })
            .catch(() => undefined);
        }
      } catch (err) {
        if (cancelled) return;
        setSnap((s) => ({
          ...s,
          healthy: false,
          postgresOk: null,
          r2Ok: null,
          lastError: err instanceof Error ? err.message : String(err),
          pendingEvents: queueSize(),
        }));
      }
    }

    // Fire once immediately so the UI has a real value before the first interval tick.
    probe();
    const handle = setInterval(probe, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, []);

  return snap;
}
