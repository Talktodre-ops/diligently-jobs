import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { GripHorizontal, MousePointer, MousePointerClick } from "lucide-react";

/**
 * Tiny bar at the very top of the popover that:
 *   1. Acts as a drag handle (`data-tauri-drag-region`) so the window can be
 *      moved around by grabbing this strip.
 *   2. Exposes the existing click-through toggle (WS_EX_TRANSPARENT) so the
 *      user can pass clicks through the entire overlay to whatever's
 *      underneath (browser, IDE, video call window).
 *
 * Important UX caveat for click-through: once enabled, the whole window —
 * including this button — stops receiving clicks. The user must use the
 * global hotkey `Ctrl+Shift+P` to toggle it back off. We mention this in the
 * button tooltip so it's not a one-way door.
 */
export const WindowControls = () => {
  const [clickThrough, setClickThrough] = useState(false);

  // Pull current state on mount + subscribe to the global-shortcut-driven
  // changes so this button stays in sync if the user uses Ctrl+Shift+P.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cur = await invoke<boolean>("get_click_through");
        if (!cancelled) setClickThrough(cur);
      } catch {
        // command not registered — nothing to do
      }
    })();

    let unlisten: (() => void) | undefined;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<boolean>("click-through-changed", (e) => {
        setClickThrough(!!e.payload);
      });
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const toggle = async () => {
    try {
      await invoke("set_click_through", { enabled: !clickThrough });
      setClickThrough(!clickThrough);
    } catch (e) {
      console.error("[click-through] toggle failed", e);
    }
  };

  return (
    <div className="flex items-center border-b border-input/40 bg-muted/30">
      {/* The drag-handle area — Tauri makes this region grabbable via
          WM_NCLBUTTONDOWN dispatch. Buttons inside the popover are NOT
          affected (Tauri excludes form controls from drag). */}
      <div
        data-tauri-drag-region
        className="flex-1 flex items-center gap-2 px-3 py-1.5 cursor-grab active:cursor-grabbing"
        title="Drag to reposition the window"
      >
        <GripHorizontal className="h-3 w-3 text-muted-foreground pointer-events-none" />
        <span className="text-xs text-muted-foreground pointer-events-none">
          drag to move
        </span>
      </div>

      <button
        type="button"
        onClick={toggle}
        className={`flex items-center gap-1.5 px-3 py-1.5 text-xs transition-colors hover:bg-accent ${
          clickThrough ? "bg-orange-500/15 text-orange-600 dark:text-orange-400" : "text-muted-foreground"
        }`}
        title={
          clickThrough
            ? "Click-through is ON — overlay is invisible to clicks. Press Ctrl+Shift+P to disable."
            : "Enable click-through (whole overlay becomes invisible to clicks; press Ctrl+Shift+P to disable later)"
        }
      >
        {clickThrough ? (
          <MousePointer className="h-3 w-3" />
        ) : (
          <MousePointerClick className="h-3 w-3" />
        )}
        {clickThrough ? "Click-through ON" : "Click-through"}
      </button>
    </div>
  );
};
