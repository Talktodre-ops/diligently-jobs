// OS-level anti-detection hardening.
//
// All public functions are no-ops on non-Windows targets so callers can stay
// platform-agnostic. macOS parity is tracked separately in Track 3F of TASKS.md.

#[cfg(target_os = "windows")]
mod windows_impl {
    use std::sync::Mutex;
    use tauri::{Runtime, WebviewWindow};
    use windows::Win32::Foundation::HWND;
    use windows::core::w;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowDisplayAffinity, GetWindowLongPtrW, SetWindowDisplayAffinity,
        SetWindowLongPtrW, SetWindowTextW, GWL_EXSTYLE, WDA_EXCLUDEFROMCAPTURE,
        WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
    };

    // Global click-through state. Toggled at runtime; persists across set_click_through calls.
    static CLICK_THROUGH: Mutex<bool> = Mutex::new(false);

    fn hwnd_of<R: Runtime>(window: &WebviewWindow<R>) -> Option<HWND> {
        window.hwnd().ok().map(|h| HWND(h.0 as *mut _))
    }

    /// Apply baseline stealth styles to a window.
    ///
    /// - `WDA_EXCLUDEFROMCAPTURE` — hides the window from screen capture APIs (GDI BitBlt,
    ///    DXGI Desktop Duplication, the Snipping Tool, OBS Display Capture, Zoom screenshare).
    ///    Requires Windows 10 2004 (build 19041) or newer.
    /// - `WS_EX_TOOLWINDOW` — removes the window from Alt+Tab and from default `EnumWindows`
    ///    enumeration; tools that don't pass `INCLUDE_TOOLWINDOWS` will not see it.
    /// - `WS_EX_NOACTIVATE` — window does not steal focus when shown or clicked.
    ///
    /// Logs the result of `GetWindowDisplayAffinity` afterward so we can verify in dev that
    /// the affinity actually applied (some Win32 calls succeed silently and the verification
    /// matters more than the return code).
    pub fn apply_stealth_styles<R: Runtime>(window: &WebviewWindow<R>) {
        let Some(hwnd) = hwnd_of(window) else {
            eprintln!("[stealth] could not obtain HWND for window");
            return;
        };

        unsafe {
            // 1. Exclude from screen capture.
            if let Err(e) = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE) {
                eprintln!("[stealth] SetWindowDisplayAffinity failed: {e:?}");
            }

            // 2. Verify it actually applied. windows-rs 0.59 binds the out param as *mut u32
            //    even though SetWindowDisplayAffinity takes the typed WINDOW_DISPLAY_AFFINITY.
            //    WDA_EXCLUDEFROMCAPTURE.0 = 0x11 on Win10 2004+.
            let mut current: u32 = 0;
            match GetWindowDisplayAffinity(hwnd, &mut current) {
                Ok(()) => {
                    if current == WDA_EXCLUDEFROMCAPTURE.0 {
                        println!("[stealth] WDA_EXCLUDEFROMCAPTURE confirmed active");
                    } else {
                        eprintln!(
                            "[stealth] display affinity did NOT take effect: got 0x{:x} (expected 0x{:x}). \
                             OS may be older than Win10 2004 (build 19041), or a group policy is overriding it.",
                            current, WDA_EXCLUDEFROMCAPTURE.0
                        );
                    }
                }
                Err(e) => eprintln!("[stealth] GetWindowDisplayAffinity failed: {e:?}"),
            }

            // 3. Force-clear the window title. Many enumerators (Get-Process MainWindowTitle,
            //    Task Manager Apps tab, EnumWindows + GetWindowText) key off this string.
            //    tauri.conf.json sets it to "" already; this is belt-and-suspenders.
            if let Err(e) = SetWindowTextW(hwnd, w!("")) {
                eprintln!("[stealth] SetWindowTextW failed: {e:?}");
            }

            // 4. Add WS_EX_TOOLWINDOW + WS_EX_NOACTIVATE to extended style.
            //    This hides from Alt+Tab and prevents focus theft on click.
            let current_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let new_style =
                current_style | WS_EX_TOOLWINDOW.0 as isize | WS_EX_NOACTIVATE.0 as isize;
            let prev = SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_style);
            if prev == 0 {
                // SetWindowLongPtrW returns 0 on failure OR if previous value was 0;
                // we can't distinguish here without GetLastError, but a failure log is harmless.
                eprintln!("[stealth] SetWindowLongPtrW(GWL_EXSTYLE) returned 0 — verify Spy++ if window styles look off");
            } else {
                println!(
                    "[stealth] extended styles applied: was 0x{:x}, now 0x{:x}",
                    prev, new_style
                );
            }
        }
    }

    /// Toggle click-through (mouse pass-through) mode on a window.
    ///
    /// When enabled, mouse events pass through the window to whatever's underneath. Useful
    /// when the overlay is purely informational and you want to interact with apps below it.
    /// Implemented via `WS_EX_TRANSPARENT` extended style. Note: callers should typically
    /// pair this with `WebviewWindow::set_ignore_cursor_events(enabled)` which manages the
    /// `WS_EX_LAYERED` flag — without LAYERED, TRANSPARENT silently no-ops on most setups.
    pub fn set_click_through<R: Runtime>(window: &WebviewWindow<R>, enabled: bool) {
        let Some(hwnd) = hwnd_of(window) else {
            eprintln!("[stealth] set_click_through: could not obtain HWND");
            return;
        };

        unsafe {
            let current = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let new = if enabled {
                current | WS_EX_TRANSPARENT.0 as isize
            } else {
                current & !(WS_EX_TRANSPARENT.0 as isize)
            };
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new);
        }

        if let Ok(mut state) = CLICK_THROUGH.lock() {
            *state = enabled;
        }
        println!("[stealth] click-through = {enabled}");
    }

    pub fn is_click_through() -> bool {
        CLICK_THROUGH.lock().map(|g| *g).unwrap_or(false)
    }
}

#[cfg(target_os = "windows")]
pub use windows_impl::{apply_stealth_styles, is_click_through, set_click_through};

// Non-Windows stubs — keep callers platform-agnostic.
#[cfg(not(target_os = "windows"))]
mod stub_impl {
    use tauri::{Runtime, WebviewWindow};

    pub fn apply_stealth_styles<R: Runtime>(_window: &WebviewWindow<R>) {
        // macOS parity (NSWindowSharingNone, collectionBehavior) tracked in TASKS.md Track 3F.
    }

    pub fn set_click_through<R: Runtime>(_window: &WebviewWindow<R>, _enabled: bool) {}

    pub fn is_click_through() -> bool {
        false
    }
}

#[cfg(not(target_os = "windows"))]
pub use stub_impl::{apply_stealth_styles, is_click_through, set_click_through};
