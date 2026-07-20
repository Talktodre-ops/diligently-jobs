// Dual-write logger: browser devtools console AND the cargo terminal where
// `npm run tauri dev` is running.
//
// Why: in Tauri 2 dev mode, `console.log` from JS only surfaces in the
// webview's devtools (right-click → Inspect). That's invisible when the
// terminal is the usual debug surface, so JS-side instrumentation feels
// like it "isn't running" even when it is. devLog mirrors to the terminal
// via the dev_log Tauri command (registered in src-tauri/src/lib.rs) so
// both surfaces show every line.
//
// The Tauri invoke is best-effort — silently swallows failures so a
// non-Tauri context (unit tests, SSR) doesn't blow up.

import { invoke } from "@tauri-apps/api/core";

export function devLog(...args: unknown[]): void {
  const line = args
    .map((a) => {
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
  // Browser devtools mirror — keeps the existing surface working.
  console.log(line);
  // Terminal mirror — silently ignored outside Tauri.
  invoke("dev_log", { line }).catch(() => {});
}
