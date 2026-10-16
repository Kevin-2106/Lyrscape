//! In-memory state survives destruction of the control WebView. No hidden keeper view.
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

pub fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireMessage {
    pub connection_id: String,
    pub payload: Value,
    pub sequence: u64,
    pub received_at_epoch_ms: u64,
}

pub struct SessionData {
    pub control_active: bool,
    snapshot: Option<Value>,
    bundles: Vec<Value>,
    sequence: u64,
    messages: BTreeMap<String, BTreeMap<String, WireMessage>>,
    clocks: BTreeMap<String, TransportClock>,
}

#[derive(Default)]
struct TransportClock {
    position: u64,
    playing: bool,
    at: u64,
}

impl TransportClock {
    fn position_at(&self, now: u64) -> u64 {
        self.position
            + if self.playing {
                now.saturating_sub(self.at).min(5000)
            } else {
                0
            }
    }
    fn toggle(&mut self, playing: bool, now: u64) -> u64 {
        self.position = self.position_at(now);
        self.at = now;
        self.playing = playing;
        self.position
    }
}

impl Default for SessionData {
    fn default() -> Self {
        Self {
            control_active: true,
            snapshot: None,
            bundles: vec![],
            sequence: 0,
            messages: BTreeMap::new(),
            clocks: BTreeMap::new(),
        }
    }
}

impl SessionData {
    fn record(&mut self, connection: &str, payload: Value) -> WireMessage {
        self.sequence += 1;
        let mut message = WireMessage {
            connection_id: connection.into(),
            payload,
            sequence: self.sequence,
            received_at_epoch_ms: epoch_ms(),
        };
        if let Some(update) = message
            .payload
            .pointer("/value/update")
            .and_then(Value::as_str)
            .map(str::to_owned)
        {
            let messages = self.messages.entry(connection.into()).or_default();
            if update == "setMusic" {
                messages.clear();
            }
            let clock = self.clocks.entry(connection.into()).or_default();
            match update.as_str() {
                "setMusic" => {
                    *clock = TransportClock {
                        at: message.received_at_epoch_ms,
                        ..Default::default()
                    };
                }
                "progress" => {
                    clock.position = message.payload["value"]["progress"].as_u64().unwrap_or(0);
                    clock.at = message.received_at_epoch_ms;
                }
                "paused" | "resumed" => {
                    // Replay must retain the position at the transition, even if
                    // earlier resume/pause messages have already been coalesced.
                    let position = clock.toggle(update == "resumed", message.received_at_epoch_ms);
                    messages.insert("progress".into(), WireMessage { payload: json!({"type":"state","value":{"update":"progress","progress":position}}), ..message.clone() });
                    self.sequence += 1;
                    message.sequence = self.sequence;
                }
                _ => {}
            }
            let key = match update.as_str() {
                "paused" | "resumed" => "playing",
                other => other,
            };
            if matches!(key, "setMusic" | "setLyric" | "progress" | "playing") {
                messages.insert(key.into(), message.clone());
            }
        }
        message
    }

    fn publish(&mut self, payload: Value) {
        if payload.get("state").is_some() {
            let mut payload = payload;
            if payload.get("demoSnapshot").is_none() {
                if let Some(demo) = self.snapshot.as_ref().and_then(|s| s.get("demoSnapshot")) {
                    payload["demoSnapshot"] = demo.clone();
                }
            }
            self.snapshot = Some(payload);
        } else if let Some(snapshot) = self.snapshot.as_mut() {
            snapshot["state"]["playback"] = payload["playback"].clone();
            snapshot["sampleAgeMs"] = payload["sampleAgeMs"].clone();
            snapshot["sentAtEpochMs"] = payload["sentAtEpochMs"].clone();
        }
    }
}

#[derive(Default)]
pub struct Session(pub Mutex<SessionData>);

impl Session {
    pub fn control_replay(&self) -> Vec<WireMessage> {
        let data = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let now = epoch_ms();
        let mut messages: Vec<_> = data
            .messages
            .values()
            .flat_map(|items| items.values())
            .cloned()
            .collect();
        messages.sort_by_key(|message| message.sequence);
        // Legacy editable adapters only understand events. Their rebuilt realm
        // receives current progress, rather than treating an old sample as fresh.
        for message in &mut messages {
            if message
                .payload
                .pointer("/value/update")
                .and_then(Value::as_str)
                == Some("progress")
            {
                if let Some(clock) = data.clocks.get(&message.connection_id) {
                    message.payload["value"]["progress"] = json!(clock.position_at(now));
                }
            }
            message.received_at_epoch_ms = now;
        }
        messages
    }
    pub fn record(&self, connection: &str, payload: Value) -> WireMessage {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .record(connection, payload)
    }
    pub fn disconnect(&self, connection: &str) {
        let mut data = self.0.lock().unwrap_or_else(|e| e.into_inner());
        data.messages.remove(connection);
        data.clocks.remove(connection);
    }
}

fn require_surface(window: &WebviewWindow) -> Result<(), String> {
    if matches!(window.label(), "main" | "overlay") {
        Ok(())
    } else {
        Err("Only lyric windows can access the session".into())
    }
}

#[tauri::command]
pub fn session_restore(
    window: WebviewWindow,
    session: State<'_, Session>,
) -> Result<Value, String> {
    require_surface(&window)?;
    let data = session.0.lock().map_err(|_| "Session unavailable")?;
    Ok(json!({ "snapshot": data.snapshot, "controlActive": data.control_active }))
}

#[tauri::command]
pub fn session_publish(
    app: AppHandle,
    window: WebviewWindow,
    session: State<'_, Session>,
    event: String,
    payload: Value,
) -> Result<(), String> {
    require_surface(&window)?;
    if !matches!(event.as_str(), "lyrscape-state" | "lyrscape-playback") {
        return Err("Invalid session event".into());
    }
    {
        let mut data = session.0.lock().map_err(|_| "Session unavailable")?;
        if window.label() == "overlay" && data.control_active {
            return Ok(());
        }
        if window.label() == "main" && !data.control_active {
            return Ok(());
        }
        data.publish(payload.clone());
    }
    if window.label() == "main" {
        app.emit_to(
            tauri::EventTarget::webview_window("overlay"),
            &event,
            &payload,
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn amll_replay(
    app: AppHandle,
    window: WebviewWindow,
    session: State<'_, Session>,
    broker: State<'_, crate::broker::Broker>,
) -> Result<Value, String> {
    require_surface(&window)?;
    let status = broker.status().await;
    let data = session.0.lock().map_err(|_| "Session unavailable")?;
    let mut messages: Vec<_> = data
        .messages
        .values()
        .flat_map(|items| items.values())
        .cloned()
        .collect();
    messages.sort_by_key(|item| item.sequence);
    let selected = app.state::<crate::audio::AudioHub>().selected_source();
    Ok(
        json!({ "status": status, "messages": messages, "controlActive": data.control_active, "selectedConnection": selected }),
    )
}

#[tauri::command]
pub fn session_bundles(
    window: WebviewWindow,
    session: State<'_, Session>,
    bundles: Option<Vec<Value>>,
) -> Result<Vec<Value>, String> {
    require_surface(&window)?;
    if bundles.is_some() {
        super::require_control(&window)?;
    }
    let mut data = session.0.lock().map_err(|_| "Session unavailable")?;
    if let Some(bundles) = bundles {
        data.bundles = bundles;
    }
    Ok(data.bundles.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replay_keeps_latest_updates_in_order_and_drops_previous_tracks_and_clients() {
        let mut data = SessionData::default();
        let msg = |update, n| json!({"type":"state","value":{"update":update,"progress":n}});
        data.record("a", msg("setMusic", 0));
        for n in 0..1000 {
            data.record("a", msg("progress", n));
        }
        assert_eq!(
            data.messages["a"]["progress"].payload["value"]["progress"],
            999
        );
        data.record("a", msg("resumed", 0));
        data.record("a", msg("paused", 0));
        assert_eq!(data.messages["a"].len(), 3);
        assert_eq!(
            data.messages["a"]["playing"].payload["value"]["update"],
            "paused"
        );
        data.record("a", msg("setMusic", 0));
        assert_eq!(data.messages["a"].len(), 1);
        data.record("b", msg("setMusic", 0));
        assert_eq!(data.messages.len(), 2);
    }
    #[test]
    fn playback_only_updates_preserve_the_document_and_replace_its_clock_anchor() {
        let mut data = SessionData::default();
        data.publish(json!({"state":{"lyrics":{"lines":["keep"]},"playback":{"positionMs":0}},"sampleAgeMs":0,"sentAtEpochMs":10}));
        data.publish(json!({"playback":{"positionMs":100},"sampleAgeMs":20,"sentAtEpochMs":30}));
        let value = data.snapshot.unwrap();
        assert_eq!(value["state"]["lyrics"]["lines"][0], "keep");
        assert_eq!(value["state"]["playback"]["positionMs"], 100);
        assert_eq!(value["sentAtEpochMs"], 30);
    }
    #[test]
    fn transport_clock_keeps_paused_position_through_multiple_toggles_and_caps_stale_samples() {
        let mut clock = TransportClock {
            position: 1000,
            playing: false,
            at: 0,
        };
        assert_eq!(clock.toggle(true, 1000), 1000);
        assert_eq!(clock.toggle(false, 2000), 2000);
        assert_eq!(clock.toggle(true, 3000), 2000);
        assert_eq!(clock.toggle(false, 10000), 7000);
    }
}
