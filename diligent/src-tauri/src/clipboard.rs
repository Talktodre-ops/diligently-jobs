//! Stealth copy via Windows UI Automation.
//!
//! On Ctrl+C-blocking pages (proctoring sites, exam apps), the host page's
//! JavaScript intercepts the copy keystroke and refuses to put text on the
//! clipboard. UI Automation operates at the OS accessibility layer, BELOW
//! the page's JS — Chrome/Edge/Firefox expose their DOM to UIA for screen
//! readers, so we can read the currently-selected text without dispatching
//! any keyboard or clipboard events the page can observe.
//!
//! The "find a usable text element" strategy matters a lot for browsers:
//! `IUIAutomation::GetFocusedElement()` returns whatever has KEYBOARD focus
//! (often the URL bar or a tab button) — NOT the page body where the mouse
//! selection lives. So we walk the foreground window's subtree and pick
//! the first TextPattern-supporting element with the data we want.
//!
//! Caveats worth knowing:
//! - Hardened exam browsers (Respondus LockDown Browser etc.) may disable
//!   UIA entirely. There is no software workaround for that.
//! - Chrome builds its UIA tree lazily on first AT request. The first call
//!   after a fresh tab may take ~200-500ms while the tree initializes.
//! - For F13 (selection copy): user must have text selected somewhere
//!   under the foreground window. We report `no_selection` if every
//!   TextPattern element comes back with an empty selection.
//!
//! Error categories returned (so the JS side can decide retry behavior):
//! - `no_foreground:`     — no foreground window (rare; shouldn't happen)
//! - `uia_init_failed:`   — UIA COM object creation / tree query failed
//! - `no_text_pattern:`   — foreground window's subtree has nothing that
//!                          supports TextPattern (rare; some native apps)
//! - `no_selection:`      — TextPattern elements exist but selection is
//!                          empty everywhere
//! - `empty_document:`    — for the F13+A document path, the element's
//!                          DocumentRange returned no text
//! - `clipboard_*:`       — Win32 clipboard write failed at some step

#[cfg(target_os = "windows")]
mod windows_impl {
    use windows::core::Interface;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalUnlock, GHND,
    };
    use windows::Win32::System::Ole::CF_UNICODETEXT;
    use windows::Win32::System::Variant::VARIANT;
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationElement,
        IUIAutomationTextPattern, TreeScope_Subtree,
        UIA_IsTextPatternAvailablePropertyId, UIA_TextPatternId,
    };
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    /// Read ALL text from the document of the focused window's primary
    /// text element via UIA's DocumentRange, and write it to the clipboard.
    /// Distinct from copy_focused_selection: no selection state is created
    /// or modified — DocumentRange is a virtual span covering everything
    /// the element exposes, so this never produces a visible highlight.
    /// Powers the F13+A chord (Ctrl+A-equivalent, but invisible).
    pub fn copy_focused_document_text() -> Result<String, String> {
        let (automation, root) = uia_init()?;
        let text = find_document_text(&automation, &root)?;
        write_clipboard_text(&text)?;
        Ok(text)
    }

    /// Read the currently-selected text from the foreground window via
    /// UIA, write it to the system clipboard, and return the text. Walks
    /// the window's UIA subtree to find an element with a non-empty
    /// selection — handles the Chrome case where the focused element is
    /// the URL bar but the selection lives on the page body.
    pub fn copy_focused_selection() -> Result<String, String> {
        let (automation, root) = uia_init()?;
        let text = find_selection_text(&automation, &root)?;
        write_clipboard_text(&text)?;
        Ok(text)
    }

    /// Init COM + UIA, get the foreground window's automation element.
    fn uia_init() -> Result<(IUIAutomation, IUIAutomationElement), String> {
        // COM apartment init. RPC_E_CHANGED_MODE just means another part of
        // the process already initialized COM in a different mode; cross-
        // apartment UIA calls still work in that case, so we ignore it.
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        }

        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.0.is_null() {
            return Err("no_foreground: no foreground window".into());
        }

        let automation: IUIAutomation = unsafe {
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| format!("uia_init_failed: CoCreateInstance: {}", e))?
        };

        // ElementFromHandle gives us the foreground window's automation
        // element. From there we walk down to find a TextPattern element —
        // this is more robust than GetFocusedElement (which returns the
        // keyboard-focused control, often the wrong thing for browser text).
        let root = unsafe {
            automation
                .ElementFromHandle(hwnd)
                .map_err(|e| format!("uia_init_failed: ElementFromHandle: {}", e))?
        };

        Ok((automation, root))
    }

    /// Find an element under `root` with a non-empty text selection.
    /// Returns the combined selection text trimmed.
    fn find_selection_text(
        automation: &IUIAutomation,
        root: &IUIAutomationElement,
    ) -> Result<String, String> {
        // Fast path: root itself sometimes supports TextPattern.
        if let Some(text) = try_read_selection_from(root) {
            return Ok(text);
        }

        let elements = find_text_pattern_elements(automation, root)?;
        let count = unsafe { elements.Length() }
            .map_err(|e| format!("uia_init_failed: array Length: {}", e))?;
        if count == 0 {
            return Err("no_text_pattern: no element under the foreground window supports TextPattern".into());
        }

        for i in 0..count {
            let Ok(elem) = (unsafe { elements.GetElement(i) }) else {
                continue;
            };
            if let Some(text) = try_read_selection_from(&elem) {
                return Ok(text);
            }
        }

        Err("no_selection: nothing selected — highlight text first".into())
    }

    /// Find an element under `root` and return its full document text via
    /// TextPattern.DocumentRange. Picks the FIRST TextPattern element with
    /// non-empty document text — for browsers, that's typically the page
    /// body (the URL bar comes first in tree order but is short, so we
    /// prefer longer docs by skipping anything under ~10 chars then falling
    /// back to whatever's available).
    fn find_document_text(
        automation: &IUIAutomation,
        root: &IUIAutomationElement,
    ) -> Result<String, String> {
        if let Some(text) = try_read_document_from(root) {
            if text.len() >= 10 {
                return Ok(text);
            }
        }

        let elements = find_text_pattern_elements(automation, root)?;
        let count = unsafe { elements.Length() }
            .map_err(|e| format!("uia_init_failed: array Length: {}", e))?;
        if count == 0 {
            return Err("no_text_pattern: no element under the foreground window supports TextPattern".into());
        }

        // Two-pass: prefer documents with >=10 chars (skip URL bar / labels);
        // fall back to the first non-empty one if everything's short.
        let mut fallback: Option<String> = None;
        for i in 0..count {
            let Ok(elem) = (unsafe { elements.GetElement(i) }) else {
                continue;
            };
            if let Some(text) = try_read_document_from(&elem) {
                if text.len() >= 10 {
                    return Ok(text);
                }
                if fallback.is_none() {
                    fallback = Some(text);
                }
            }
        }

        fallback.ok_or_else(|| "empty_document: every TextPattern element returned empty text".into())
    }

    /// Use IUIAutomation::FindAll with IsTextPatternAvailable=true to
    /// enumerate every text-supporting element under `root`. TreeScope is
    /// Subtree so root itself is included if it qualifies.
    fn find_text_pattern_elements(
        automation: &IUIAutomation,
        root: &IUIAutomationElement,
    ) -> Result<windows::Win32::UI::Accessibility::IUIAutomationElementArray, String> {
        let true_var: VARIANT = true.into();
        let condition = unsafe {
            automation
                .CreatePropertyCondition(UIA_IsTextPatternAvailablePropertyId, &true_var)
                .map_err(|e| format!("uia_init_failed: CreatePropertyCondition: {}", e))?
        };
        // Subtree (not just Descendants) so root counts. FindAll is sync
        // and on first call for a new browser tab can take 200-500ms while
        // Chrome builds its UIA tree.
        let elements = unsafe {
            root.FindAll(TreeScope_Subtree, &condition)
                .map_err(|e| format!("no_text_pattern: FindAll: {}", e))?
        };
        Ok(elements)
    }

    /// Attempt to read selection from this element. Returns None if the
    /// element doesn't support TextPattern, doesn't have a selection, or
    /// the selection is empty. Never returns an error — caller moves on.
    fn try_read_selection_from(elem: &IUIAutomationElement) -> Option<String> {
        // GetCurrentPattern can return Err(HRESULT(S_OK)) when the COM
        // call itself succeeded but the element doesn't support the pattern
        // (null IUnknown wrapped as Err in windows-rs). We treat any error
        // here as "not supported" and move on.
        let pattern_unk = unsafe { elem.GetCurrentPattern(UIA_TextPatternId).ok()? };
        let text_pattern: IUIAutomationTextPattern = pattern_unk.cast().ok()?;

        let ranges = unsafe { text_pattern.GetSelection().ok()? };
        let count = unsafe { ranges.Length() }.ok()?;
        if count == 0 {
            return None;
        }

        let mut combined = String::new();
        for i in 0..count {
            let range = unsafe { ranges.GetElement(i) }.ok()?;
            let bstr = unsafe { range.GetText(-1) }.ok()?;
            if i > 0 {
                combined.push('\n');
            }
            combined.push_str(&bstr.to_string());
        }
        let trimmed = combined.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    }

    /// Attempt to read the full document text from this element via
    /// DocumentRange.GetText(-1). Returns None on any error (element
    /// doesn't support TextPattern, etc.) or if the text is empty.
    fn try_read_document_from(elem: &IUIAutomationElement) -> Option<String> {
        let pattern_unk = unsafe { elem.GetCurrentPattern(UIA_TextPatternId).ok()? };
        let text_pattern: IUIAutomationTextPattern = pattern_unk.cast().ok()?;
        let doc_range = unsafe { text_pattern.DocumentRange().ok()? };
        let bstr = unsafe { doc_range.GetText(-1) }.ok()?;
        let trimmed = bstr.to_string().trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    }

    fn write_clipboard_text(text: &str) -> Result<(), String> {
        // UTF-16 little-endian with trailing NUL (clipboard contract).
        let mut utf16: Vec<u16> = text.encode_utf16().collect();
        utf16.push(0);
        let bytes = utf16.len() * std::mem::size_of::<u16>();

        unsafe {
            // OpenClipboard(None) grants the current thread clipboard
            // ownership without associating a window handle. windows-rs 0.59
            // models NULL HWND as Option<HWND>::None.
            OpenClipboard(None)
                .map_err(|e| format!("clipboard_open: {}", e))?;

            // Wrap the rest in a closure so any error path still hits
            // CloseClipboard. Leaving the clipboard open hangs other apps'
            // copy/paste until our process exits.
            let result: Result<(), String> = (|| {
                EmptyClipboard().map_err(|e| format!("clipboard_empty: {}", e))?;

                // GHND = GMEM_MOVEABLE | GMEM_ZEROINIT. Clipboard requires
                // movable memory; zero-init is cheap insurance against junk
                // bytes if the UTF-16 buffer is shorter than allocated.
                let hmem = GlobalAlloc(GHND, bytes)
                    .map_err(|e| format!("clipboard_alloc: {}", e))?;
                let ptr = GlobalLock(hmem) as *mut u16;
                if ptr.is_null() {
                    // Note: GlobalFree is deprecated and not bound in
                    // windows 0.59 Memory module. On this rare failure path
                    // the small allocation is leaked until process exit —
                    // acceptable for an error case (~few KB at most).
                    return Err("clipboard_lock: GlobalLock returned NULL".into());
                }
                std::ptr::copy_nonoverlapping(utf16.as_ptr(), ptr, utf16.len());
                let _ = GlobalUnlock(hmem);

                // SetClipboardData TRANSFERS ownership of hmem to the
                // clipboard on success; on failure the buffer is leaked
                // (same rationale as above).
                let handle = HANDLE(hmem.0);
                SetClipboardData(CF_UNICODETEXT.0 as u32, Some(handle))
                    .map_err(|e| format!("clipboard_set: {}", e))?;
                Ok(())
            })();

            let _ = CloseClipboard();
            result
        }
    }

}

#[cfg(target_os = "windows")]
pub use windows_impl::{copy_focused_document_text, copy_focused_selection};

#[cfg(not(target_os = "windows"))]
pub fn copy_focused_selection() -> Result<String, String> {
    Err("stealth_copy_selection is Windows-only".into())
}

#[cfg(not(target_os = "windows"))]
pub fn copy_focused_document_text() -> Result<String, String> {
    Err("stealth_copy_document is Windows-only".into())
}
