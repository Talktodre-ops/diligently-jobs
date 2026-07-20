use tauri::{Manager, App, WebviewWindow};

// The offset from the top of the screen to the window
const TOP_OFFSET: i32 = 54;

/// Sets up the main window with custom positioning.
pub fn setup_main_window(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    // Try different possible window labels
    let window = app.get_webview_window("main")
        .or_else(|| app.get_webview_window("diligently"))
        .or_else(|| {
            // Get the first window if specific labels don't work
            app.webview_windows().values().next().cloned()
        })
        .ok_or("No window found")?;

    position_window_top_center(&window, TOP_OFFSET)?;

    Ok(())
}

/// Positions a window at the top center of the screen with a specified Y offset
pub fn position_window_top_center(window: &WebviewWindow, y_offset: i32) -> Result<(), Box<dyn std::error::Error>> {
    // Get the primary monitor
    if let Some(monitor) = window.primary_monitor()? {
        let monitor_size = monitor.size();
        let window_size = window.outer_size()?;
        
        // Calculate center X position
        let center_x = (monitor_size.width as i32 - window_size.width as i32) / 2;
        
        // Set the window position
        window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
            x: center_x,
            y: y_offset,
        }))?;
    }
    
    Ok(())
}

