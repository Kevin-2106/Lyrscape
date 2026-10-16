use serde::Serialize;
use std::{collections::BTreeMap, sync::Mutex};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

const ACTIONS: [&str; 3] = ["visibility", "clickthrough", "border"];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingStatus {
    pub action: String,
    pub accelerator: String,
    pub registered: bool,
    pub error: Option<String>,
}

struct Binding {
    status: BindingStatus,
    shortcut: Option<Shortcut>,
}

#[derive(Default)]
pub struct ShortcutRegistry(Mutex<BTreeMap<String, Binding>>);

fn parse_binding(action: &str, accelerator: &str) -> Result<Option<Shortcut>, String> {
    if !ACTIONS.contains(&action) {
        return Err("未知快捷键操作".into());
    }
    if accelerator.is_empty() {
        return Ok(None);
    }
    if accelerator.len() > 80 {
        return Err("快捷键过长".into());
    }
    let shortcut: Shortcut = accelerator
        .parse()
        .map_err(|_| "快捷键格式无效".to_owned())?;
    // Global single-character bindings interfere with normal typing.
    if shortcut.mods.is_empty() {
        return Err("全局快捷键至少需要一个修饰键".into());
    }
    Ok(Some(shortcut))
}

#[tauri::command]
pub fn shortcuts_status(
    window: WebviewWindow,
    registry: State<'_, ShortcutRegistry>,
) -> Result<Vec<BindingStatus>, String> {
    super::require_control(&window)?;
    Ok(registry
        .0
        .lock()
        .map_err(|_| "快捷键状态不可用")?
        .values()
        .map(|b| b.status.clone())
        .collect())
}

#[tauri::command]
pub fn shortcut_set(
    app: AppHandle,
    window: WebviewWindow,
    registry: State<'_, ShortcutRegistry>,
    action: String,
    accelerator: String,
) -> Result<Vec<BindingStatus>, String> {
    super::require_control(&window)?;
    let parsed = parse_binding(&action, &accelerator)?;
    let mut bindings = registry.0.lock().map_err(|_| "快捷键状态不可用")?;
    if let Some(next) = parsed {
        if let Some(other) = bindings
            .values()
            .find(|b| b.status.action != action && b.shortcut.is_some_and(|s| s.id() == next.id()))
        {
            return Err(format!("快捷键冲突：已用于 {}", other.status.action));
        }
    }
    let old = bindings.get(&action).and_then(|b| b.shortcut);
    if parsed.map(|s| s.id()) != old.map(|s| s.id()) {
        // Reserve the new combination first. An OS conflict leaves the old key working.
        if let Some(next) = parsed {
            if let Err(error) = app.global_shortcut().register(next) {
                let message = format!(
                    "无法注册 {accelerator}：可能被其他程序或系统占用。原快捷键保留。({error})"
                );
                if old.is_none() {
                    bindings.insert(
                        action.clone(),
                        Binding {
                            shortcut: None,
                            status: BindingStatus {
                                action,
                                accelerator,
                                registered: false,
                                error: Some(message.clone()),
                            },
                        },
                    );
                }
                return Err(message);
            }
        }
        if let Some(previous) = old {
            if let Err(error) = app.global_shortcut().unregister(previous) {
                if let Some(next) = parsed {
                    let _ = app.global_shortcut().unregister(next);
                }
                return Err(format!("旧快捷键释放失败，未保存新设置：{error}"));
            }
        }
    }
    bindings.insert(
        action.clone(),
        Binding {
            shortcut: parsed,
            status: BindingStatus {
                action,
                accelerator,
                registered: parsed.is_some(),
                error: None,
            },
        },
    );
    Ok(bindings.values().map(|b| b.status.clone()).collect())
}

#[tauri::command]
pub fn shortcuts_clear(
    app: AppHandle,
    window: WebviewWindow,
    registry: State<'_, ShortcutRegistry>,
) -> Result<(), String> {
    super::require_control(&window)?;
    let mut bindings = registry.0.lock().map_err(|_| "快捷键状态不可用")?;
    for binding in bindings.values_mut() {
        if let Some(shortcut) = binding.shortcut {
            app.global_shortcut()
                .unregister(shortcut)
                .map_err(|e| e.to_string())?;
        }
        binding.shortcut = None;
        binding.status.registered = false;
    }
    Ok(())
}

pub fn handle(app: &AppHandle, shortcut: &Shortcut, event: ShortcutState) {
    if event != ShortcutState::Pressed {
        return;
    }
    let action = {
        let registry = app.state::<ShortcutRegistry>();
        let Ok(bindings) = registry.0.lock() else {
            return;
        };
        bindings
            .values()
            .find(|b| b.shortcut.is_some_and(|s| s.id() == shortcut.id()))
            .map(|b| b.status.action.clone())
    };
    if let Some(action) = action {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            if let Err(error) = super::toggle_overlay(&app, &action) {
                let _ = app.emit("shortcut-error", error);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_actions_modifiers_and_equivalent_combinations() {
        assert!(parse_binding("unknown", "Ctrl+L").is_err());
        assert!(parse_binding("border", "L").is_err());
        assert!(parse_binding("border", "Ctrl+NoSuchKey").is_err());
        assert!(parse_binding("border", "").unwrap().is_none());
        assert_eq!(
            parse_binding("border", "Ctrl+Shift+L")
                .unwrap()
                .unwrap()
                .id(),
            parse_binding("border", "Shift+Control+KeyL")
                .unwrap()
                .unwrap()
                .id()
        );
    }
}
