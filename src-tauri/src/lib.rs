mod amll_protocol;
mod broker;

use broker::{Broker, BrokerStatus};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State, WebviewWindow};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OverlayStatus {
    visible: bool,
    always_on_top: bool,
    click_through: bool,
}

impl Default for OverlayStatus {
    fn default() -> Self {
        Self {
            visible: false,
            always_on_top: true,
            click_through: false,
        }
    }
}

#[derive(Default)]
struct OverlayState(Mutex<OverlayStatus>);

fn require_control(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("This command is available only to the control window".into())
    }
}

#[tauri::command]
async fn amll_start(
    app: AppHandle,
    window: WebviewWindow,
    broker: State<'_, Broker>,
    port: Option<u16>,
    allowed_origins: Option<Vec<String>>,
) -> Result<BrokerStatus, String> {
    require_control(&window)?;
    broker
        .start(app, port.unwrap_or(11444), allowed_origins)
        .await
}

#[tauri::command]
async fn amll_stop(
    window: WebviewWindow,
    broker: State<'_, Broker>,
) -> Result<BrokerStatus, String> {
    require_control(&window)?;
    broker.stop().await
}

#[tauri::command]
async fn amll_status(
    window: WebviewWindow,
    broker: State<'_, Broker>,
) -> Result<BrokerStatus, String> {
    require_control(&window)?;
    Ok(broker.status().await)
}

#[tauri::command]
fn overlay_status(app: AppHandle, state: State<'_, OverlayState>) -> Result<OverlayStatus, String> {
    let overlay = app
        .get_webview_window("overlay")
        .ok_or("Overlay window is unavailable")?;
    let mut status = state.0.lock().map_err(|_| "Overlay state is unavailable")?;
    status.visible = overlay.is_visible().map_err(|error| error.to_string())?;
    Ok(status.clone())
}

#[tauri::command]
fn overlay_update(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, OverlayState>,
    visible: Option<bool>,
    always_on_top: Option<bool>,
    click_through: Option<bool>,
) -> Result<OverlayStatus, String> {
    require_control(&window)?;
    let overlay = app
        .get_webview_window("overlay")
        .ok_or("Overlay window is unavailable")?;
    let mut status = state.0.lock().map_err(|_| "Overlay state is unavailable")?;
    if let Some(top) = always_on_top {
        overlay
            .set_always_on_top(top)
            .map_err(|error| error.to_string())?;
        status.always_on_top = top;
    }
    if let Some(through) = click_through {
        overlay
            .set_ignore_cursor_events(through)
            .map_err(|error| error.to_string())?;
        status.click_through = through;
    }
    if let Some(visible) = visible {
        if visible {
            overlay.show()
        } else {
            overlay.hide()
        }
        .map_err(|error| error.to_string())?;
        status.visible = visible;
    }
    Ok(status.clone())
}

#[tauri::command]
fn overlay_fit(window: WebviewWindow, height: f64) -> Result<f64, String> {
    if window.label() != "overlay" {
        return Err("Only the overlay can fit its content height".into());
    }
    if !height.is_finite() || height <= 0.0 {
        return Err("Overlay height must be a positive finite number".into());
    }
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let monitor = window
        .current_monitor()
        .map_err(|error| error.to_string())?;
    let max_height = monitor
        .as_ref()
        .map(|monitor| monitor.size().height as f64 / monitor.scale_factor())
        .unwrap_or(1080.0)
        .max(90.0);
    let fitted = height.ceil().clamp(90.0, max_height);
    let size = window.inner_size().map_err(|error| error.to_string())?;
    if (size.height as f64 / scale - fitted).abs() > 0.5 {
        window
            .set_size(tauri::LogicalSize::new(size.width as f64 / scale, fitted))
            .map_err(|error| error.to_string())?;
    }
    if let Some(monitor) = monitor {
        let position = window.outer_position().map_err(|error| error.to_string())?;
        let top = monitor.position().y;
        let bottom = top + monitor.size().height as i32 - (fitted * scale).ceil() as i32;
        let y = position.y.clamp(top, bottom.max(top));
        if y != position.y {
            window
                .set_position(tauri::PhysicalPosition::new(position.x, y))
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(fitted)
}

pub fn run() {
    let app = tauri::Builder::default()
        .manage(Broker::default())
        .manage(OverlayState::default())
        .invoke_handler(tauri::generate_handler![
            amll_start,
            amll_stop,
            amll_status,
            overlay_update,
            overlay_status,
            overlay_fit
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                match window.label() {
                    "main" => window.app_handle().exit(0),
                    "overlay" => {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                    _ => {}
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Unable to initialize Lyrscape desktop host");
    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            app.state::<Broker>().shutdown_on_exit();
        }
    });
}
