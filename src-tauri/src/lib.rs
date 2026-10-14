mod amll_protocol;
mod audio;
mod broker;
mod plugin_source;
mod shortcuts;

use broker::{Broker, BrokerStatus};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OverlayStatus {
    visible: bool,
    always_on_top: bool,
    click_through: bool,
    border_visible: bool,
}

impl Default for OverlayStatus {
    fn default() -> Self {
        Self {
            visible: false,
            always_on_top: true,
            click_through: false,
            border_visible: false,
        }
    }
}

#[derive(Default)]
struct OverlayState(Mutex<OverlayStatus>, Mutex<()>);

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
    border_visible: Option<bool>,
) -> Result<OverlayStatus, String> {
    require_control(&window)?;
    update_overlay(
        &app,
        &state,
        visible,
        always_on_top,
        click_through,
        border_visible,
    )
}

fn update_overlay(
    app: &AppHandle,
    state: &OverlayState,
    visible: Option<bool>,
    always_on_top: Option<bool>,
    click_through: Option<bool>,
    border_visible: Option<bool>,
) -> Result<OverlayStatus, String> {
    let _operation = state.1.lock().map_err(|_| "Overlay state is unavailable")?;
    apply_overlay(
        app,
        state,
        visible,
        always_on_top,
        click_through,
        border_visible,
    )
}

fn apply_overlay(
    app: &AppHandle,
    state: &OverlayState,
    visible: Option<bool>,
    always_on_top: Option<bool>,
    click_through: Option<bool>,
    border_visible: Option<bool>,
) -> Result<OverlayStatus, String> {
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
    if let Some(border) = border_visible {
        status.border_visible = border;
    }
    let result = status.clone();
    drop(status);
    app.emit("overlay-status", &result)
        .map_err(|error| error.to_string())?;
    Ok(result)
}

fn toggle_overlay(app: &AppHandle, action: &str) -> Result<OverlayStatus, String> {
    let state = app.state::<OverlayState>();
    let _operation = state.1.lock().map_err(|_| "Overlay state is unavailable")?;
    // Read actual visibility because the overlay can also be closed by the window manager.
    let overlay = app
        .get_webview_window("overlay")
        .ok_or("Overlay window is unavailable")?;
    let mut status = state.0.lock().map_err(|_| "Overlay state is unavailable")?;
    let change = match action {
        "visibility" => (
            Some(!overlay.is_visible().map_err(|e| e.to_string())?),
            None,
            None,
        ),
        "clickthrough" => (None, Some(!status.click_through), None),
        "border" => (None, None, Some(!status.border_visible)),
        _ => return Err("未知桌面歌词操作".into()),
    };
    status.visible = overlay.is_visible().map_err(|e| e.to_string())?;
    drop(status);
    apply_overlay(app, &state, change.0, None, change.1, change.2)
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
        .manage(shortcuts::ShortcutRegistry::default())
        .manage(audio::AudioHub::default())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| shortcuts::handle(app, shortcut, event.state))
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            amll_start,
            amll_stop,
            amll_status,
            overlay_update,
            overlay_status,
            overlay_fit,
            shortcuts::shortcuts_status,
            shortcuts::shortcut_set,
            shortcuts::shortcuts_clear,
            audio::amll_audio_subscribe,
            audio::amll_audio_unsubscribe,
            audio::amll_audio_ack,
            audio::amll_audio_select,
            plugin_source::plugin_source,
            plugin_source::plugin_catalog
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                match window.label() {
                    "main" => window.app_handle().exit(0),
                    "overlay" => {
                        api.prevent_close();
                        let state = window.app_handle().state::<OverlayState>();
                        let _ = update_overlay(
                            window.app_handle(),
                            &state,
                            Some(false),
                            None,
                            None,
                            None,
                        );
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
