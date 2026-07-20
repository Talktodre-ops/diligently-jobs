import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { MousePointer, MousePointerClick } from "lucide-react";
import { Button } from "./ui";

/**
 * Window-management UX surfaced at the top of the main app bar:
 *
 *   1. Drag: left-click any empty space in the app bar (the gaps between
 *      buttons) and drag — this is the `data-tauri-drag-region` on the
 *      Card root. Buttons (form controls) are auto-excluded by Tauri so
 *      they still click normally.
 *
 *   2. Click-through toggle as an icon button. Once enabled the whole
 *      overlay becomes invisible to clicks (good for interview screen-share
 *      paranoia); press Ctrl+Shift+P to bring it back (the button itself is
 *      also click-through, hence the hotkey escape hatch).
 *
 *  We previously had a global "right-click-anywhere → startDragging" hook
 *  but it triggered accidentally on text/right-click in streaming responses,
 *  flinging the window off-screen. The hotkey + drag-region combination is
 *  enough.
 */
export const AppDragControls = () => {
  const [clickThrough, setClickThrough] = useState(false);

  // Suppress the OS context menu globally — this is a desktop overlay, not
  // a webpage. Keeps right-click events from popping up Inspect / Copy.
  useEffect(() => {
    const onContextMenu = (e: Event) => e.preventDefault();
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, []);

  // Mirror the global-shortcut-driven click-through state.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cur = await invoke<boolean>("get_click_through");
        if (!cancelled) setClickThrough(cur);
      } catch {
        // command not registered
      }
    })();
    let un: (() => void) | undefined;
    (async () => {
      un = await listen<boolean>("click-through-changed", (e) =>
        setClickThrough(!!e.payload)
      );
    })();
    return () => {
      cancelled = true;
      un?.();
    };
  }, []);

  const toggle = async () => {
    const next = !clickThrough;
    try {
      // Use Tauri's native setIgnoreCursorEvents — it's the cross-platform,
      // tested path. On Windows it manages WS_EX_LAYERED + WS_EX_TRANSPARENT
      // correctly (which our custom Rust impl skipped — without LAYERED,
      // TRANSPARENT silently no-ops, which was why clicks weren't actually
      // passing through despite the state flag flipping).
      await getCurrentWindow().setIgnoreCursorEvents(next);
      // Also fire the Rust command so the existing global-shortcut path +
      // state mutex stay in sync. If this fails (e.g., command not wired)
      // the cursor-event change above still took effect.
      try {
        await invoke("set_click_through", { enabled: next });
      } catch {
        /* best-effort */
      }
      setClickThrough(next);
    } catch (e) {
      console.error("[click-through] toggle failed", e);
    }
  };

  return (
    <>
      <Button
        size="icon"
        onClick={toggle}
        title={
          clickThrough
            ? "Click-through ON. Overlay ignores clicks; press Alt+F9 to disable."
            : "Toggle click-through (overlay becomes invisible to clicks; press Alt+F9 to disable later)"
        }
        className={
          clickThrough
            ? "bg-orange-500/20 hover:bg-orange-500/30 text-orange-600 dark:text-orange-400"
            : ""
        }
      >
        {clickThrough ? (
          <MousePointer className="h-4 w-4" />
        ) : (
          <MousePointerClick className="h-4 w-4" />
        )}
      </Button>

      {/* When click-through is on the user can't click ANYTHING in the app —
          buttons, popovers, none of it. The only way out is the global
          shortcut. Make that fact unmissable. */}
      {clickThrough && (
        <div
          className="fixed top-0 left-1/2 -translate-x-1/2 z-50 px-3 py-1 rounded-b-md bg-orange-500 text-white text-xs font-semibold shadow-lg pointer-events-none"
          style={{ pointerEvents: "none" }}
        >
          Click-through ON — press Alt+F9 to disable
        </div>
      )}
    </>
  );
};
