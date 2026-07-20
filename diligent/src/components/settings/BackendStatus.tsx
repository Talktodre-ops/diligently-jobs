import { useBackendHealth } from "@/hooks";
import { Header } from "@/components";

/**
 * Compact status row showing backend connectivity in the Settings popover.
 *
 *   * Green dot + last-checked time when /health is ok
 *   * Red dot + reason when degraded or unreachable
 *   * Pending-events count surfaced when non-zero (queue is draining)
 */
export const BackendStatus = () => {
  const status = useBackendHealth();

  const dotColor = status.lastChecked === null
    ? "bg-muted-foreground"
    : status.healthy
      ? "bg-emerald-500"
      : "bg-red-500";

  const label = status.lastChecked === null
    ? "checking…"
    : status.healthy
      ? "online"
      : "offline";

  const lastSeen = status.lastChecked
    ? status.lastChecked.toLocaleTimeString()
    : "never";

  return (
    <div className="flex flex-col gap-2">
      <Header
        title="Backend Sync"
        description="Audit-log + R2 backend connectivity."
      />
      <div className="flex items-center justify-between rounded-xl border border-input/30 bg-muted/30 px-3 py-2 text-xs">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className={`inline-block h-2 w-2 rounded-full ${dotColor}`}
          />
          <span className="font-medium capitalize">{label}</span>
          {status.healthy && (
            <span className="text-muted-foreground">
              · pg {status.postgresOk ? "✓" : "✗"} · r2 {status.r2Ok ? "✓" : "✗"}
            </span>
          )}
        </div>
        <span className="text-muted-foreground">last: {lastSeen}</span>
      </div>

      {!status.healthy && status.lastError && (
        <p className="text-xs text-destructive line-clamp-2 px-1">
          {status.lastError}
        </p>
      )}

      {status.pendingEvents > 0 && (
        <p className="text-xs text-muted-foreground px-1">
          {status.pendingEvents} event{status.pendingEvents === 1 ? "" : "s"}{" "}
          buffered locally — will sync once backend is reachable.
        </p>
      )}
    </div>
  );
};
