import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  Loader2Icon,
  RefreshCwIcon,
} from "lucide-react";
import { Button } from "../ui";
import { getHealth } from "@/lib/backend";

type Status = "checking" | "ok" | "fail" | "unknown";

interface Check {
  id: string;
  label: string;
  status: Status;
  detail?: string;
}

/**
 * System health dashboard — pings each subsystem the app depends on and
 * shows a red/green row per result. The most common "why isn't this
 * working?" failures (missing API key, backend unreachable, mic
 * permission denied) become a single glance to diagnose.
 */
export const SystemHealth = () => {
  const [checks, setChecks] = useState<Check[]>([
    { id: "anthropic", label: "Anthropic API key (chat)", status: "unknown" },
    { id: "deepseek", label: "DeepSeek API key (job & Upwork)", status: "unknown" },
    { id: "backend", label: "Backend reachable", status: "unknown" },
  ]);
  const [running, setRunning] = useState(false);

  const setCheck = useCallback(
    (id: string, patch: Partial<Check>) => {
      setChecks((cur) =>
        cur.map((c) => (c.id === id ? { ...c, ...patch } : c))
      );
    },
    []
  );

  const runAll = useCallback(async () => {
    if (running) return;
    setRunning(true);
    setChecks((cur) => cur.map((c) => ({ ...c, status: "checking" })));

    // Run all checks in parallel; each one updates its row when it finishes.
    await Promise.all([
      // 1. Anthropic key — just check the env-resolved value is non-empty.
      //    A real ping costs tokens; this is a presence-only check.
      (async () => {
        try {
          const key = await invoke<string | null>("get_ai_provider_api_key", {
            providerId: "claude",
          });
          if (key && key.trim()) {
            setCheck("anthropic", {
              status: "ok",
              detail: `key found (${key.slice(0, 12)}…)`,
            });
          } else {
            setCheck("anthropic", {
              status: "fail",
              detail: "ANTHROPIC_API_KEY not set in src-tauri/.env",
            });
          }
        } catch (e) {
          setCheck("anthropic", {
            status: "fail",
            detail: e instanceof Error ? e.message : String(e),
          });
        }
      })(),

      // 2. DeepSeek key — powers the job + Upwork generators. Same
      //    presence-only check (a real ping would cost tokens).
      (async () => {
        try {
          const key = await invoke<string | null>("get_ai_provider_api_key", {
            providerId: "deepseek",
          });
          if (key && key.trim()) {
            setCheck("deepseek", {
              status: "ok",
              detail: `key found (${key.slice(0, 12)}…)`,
            });
          } else {
            setCheck("deepseek", {
              status: "fail",
              detail: "DEEPSEEK_API_KEY not set in src-tauri/.env",
            });
          }
        } catch (e) {
          setCheck("deepseek", {
            status: "fail",
            detail: e instanceof Error ? e.message : String(e),
          });
        }
      })(),

      // 3. Backend reachable — uses the existing /health endpoint.
      (async () => {
        try {
          const h = await getHealth();
          const pgOk = h.postgres.ok;
          const r2Ok = h.r2.ok;
          if (pgOk && r2Ok) {
            setCheck("backend", { status: "ok", detail: "postgres ✓ r2 ✓" });
          } else {
            const issues: string[] = [];
            if (!pgOk) issues.push(`postgres: ${h.postgres.detail ?? "fail"}`);
            if (!r2Ok) issues.push(`r2: ${h.r2.detail ?? "fail"}`);
            setCheck("backend", {
              status: "fail",
              detail: issues.join(", "),
            });
          }
        } catch (e) {
          setCheck("backend", {
            status: "fail",
            detail: e instanceof Error ? e.message : "unreachable",
          });
        }
      })(),
    ]);

    setRunning(false);
  }, [running, setCheck]);

  // Run once on mount so the panel arrives populated.
  useEffect(() => {
    runAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-input/50 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-col">
          <h3 className="font-semibold text-sm">System health</h3>
          <p className="text-xs text-muted-foreground">
            Quick diagnostic for the app's API keys and backend connection.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={runAll}
          disabled={running}
          className="text-xs"
        >
          <RefreshCwIcon className={`h-3 w-3 ${running ? "animate-spin" : ""}`} />
          {running ? "Checking…" : "Re-check"}
        </Button>
      </div>

      <div className="flex flex-col gap-1.5">
        {checks.map((c) => (
          <HealthRow key={c.id} check={c} />
        ))}
      </div>
    </div>
  );
};

const STATUS_ICON: Record<Status, React.ReactNode> = {
  checking: <Loader2Icon className="h-3 w-3 animate-spin text-muted-foreground" />,
  ok: <CheckCircle2Icon className="h-3 w-3 text-emerald-500" />,
  fail: <AlertCircleIcon className="h-3 w-3 text-red-500" />,
  unknown: <AlertCircleIcon className="h-3 w-3 text-muted-foreground" />,
};

function HealthRow({ check }: { check: Check }) {
  return (
    <div className="flex items-start gap-2 text-xs">
      <span className="mt-0.5">{STATUS_ICON[check.status]}</span>
      <div className="flex-1 min-w-0">
        <div className="font-medium">{check.label}</div>
        {check.detail && (
          <div
            className={`text-xs break-words ${
              check.status === "fail"
                ? "text-red-600 dark:text-red-400"
                : "text-muted-foreground"
            }`}
          >
            {check.detail}
          </div>
        )}
      </div>
    </div>
  );
}
