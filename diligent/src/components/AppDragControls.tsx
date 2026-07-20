import { useEffect } from "react";

/**
 * Window-management UX surfaced at the top of the main app bar:
 *
 *   Drag: left-click any empty space in the app bar (the gaps between
 *   buttons) and drag — this is the `data-tauri-drag-region` on the
 *   Card root. Buttons (form controls) are auto-excluded by Tauri so
 *   they still click normally.
 *
 *  We previously had a global "right-click-anywhere → startDragging" hook
 *  but it triggered accidentally on text/right-click in streaming responses,
 *  flinging the window off-screen. The drag-region above is enough on its
 *  own.
 */
export const AppDragControls = () => {
  // Suppress the OS context menu globally — this is a desktop overlay, not
  // a webpage. Keeps right-click events from popping up Inspect / Copy.
  useEffect(() => {
    const onContextMenu = (e: Event) => e.preventDefault();
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, []);

  return null;
};
