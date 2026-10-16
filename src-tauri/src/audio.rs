use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{
    ipc::{Channel, InvokeResponseBody},
    State, WebviewWindow,
};

const MAX_PENDING: usize = 4;

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AudioPacket {
    Reset {
        #[serde(rename = "connectionId")]
        connection_id: Option<String>,
        revision: u64,
    },
    Pcm {
        #[serde(rename = "connectionId")]
        connection_id: String,
        revision: u64,
        sequence: u64,
        #[serde(rename = "receivedAtEpochMs")]
        received_at_epoch_ms: u64,
        #[serde(rename = "droppedFrames")]
        dropped_frames: u64,
        data: Vec<u8>,
        #[serde(rename = "protocolVersion")]
        protocol_version: u8,
    },
}

impl AudioPacket {
    fn into_body(self) -> InvokeResponseBody {
        match self {
            Self::Pcm {
                connection_id,
                revision,
                sequence,
                protocol_version,
                received_at_epoch_ms,
                dropped_frames,
                data,
            } => {
                let source = connection_id.as_bytes();
                let mut bytes = Vec::with_capacity(40 + source.len() + data.len());
                bytes.extend_from_slice(b"LPCM");
                bytes.extend_from_slice(&[1, protocol_version]);
                bytes.extend_from_slice(&(source.len() as u16).to_le_bytes());
                for value in [revision, sequence, received_at_epoch_ms, dropped_frames] {
                    bytes.extend_from_slice(&value.to_le_bytes());
                }
                bytes.extend_from_slice(source);
                bytes.extend_from_slice(&data);
                InvokeResponseBody::Raw(bytes)
            }
            reset => InvokeResponseBody::Json(
                serde_json::to_string(&reset).expect("audio reset serialization"),
            ),
        }
    }
}

struct Subscriber {
    channel: Channel,
    pending: BTreeSet<u64>,
    dropped: u64,
}
#[derive(Default)]
struct HubState {
    selected: Option<String>,
    revision: u64,
    sequence: u64,
    subscribers: BTreeMap<String, Subscriber>,
}
#[derive(Default)]
pub struct AudioHub(Mutex<HubState>);

impl HubState {
    fn reset(&mut self) {
        self.revision += 1;
        let packet = AudioPacket::Reset {
            connection_id: self.selected.clone(),
            revision: self.revision,
        };
        self.subscribers.retain(|_, subscriber| {
            // Retain outstanding acknowledgements across source changes: queued old packets
            // still occupy the channel. Their revision makes them invalid to the consumer.
            subscriber.dropped = 0;
            subscriber.channel.send(packet.clone().into_body()).is_ok()
        });
    }
}

impl AudioHub {
    pub fn selected_source(&self) -> Option<String> {
        self.0.lock().ok().and_then(|hub| hub.selected.clone())
    }
    pub fn remove_window(&self, label: &str) {
        if let Ok(mut hub) = self.0.lock() {
            hub.subscribers.remove(label);
        }
    }
    pub fn push(&self, connection: &str, data: Vec<u8>, protocol_version: u8) {
        let Ok(mut hub) = self.0.lock() else {
            return;
        };
        if hub.selected.as_deref() != Some(connection) {
            return;
        }
        hub.sequence += 1;
        let sequence = hub.sequence;
        let revision = hub.revision;
        let received_at_epoch_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        hub.subscribers.retain(|_, subscriber| {
            if subscriber.pending.len() >= MAX_PENDING {
                subscriber.dropped += 1;
                return true;
            }
            let packet = AudioPacket::Pcm {
                connection_id: connection.into(),
                revision,
                sequence,
                received_at_epoch_ms,
                dropped_frames: subscriber.dropped,
                data: data.clone(),
                protocol_version,
            };
            if subscriber.channel.send(packet.into_body()).is_err() {
                return false;
            }
            subscriber.pending.insert(sequence);
            subscriber.dropped = 0;
            true
        });
    }
    pub fn discontinuity(&self, connection: &str, disconnected: bool) {
        let Ok(mut hub) = self.0.lock() else {
            return;
        };
        if hub.selected.as_deref() != Some(connection) {
            return;
        }
        if disconnected {
            hub.selected = None;
        }
        hub.reset();
    }
}

fn require_audio_window(window: &WebviewWindow) -> Result<(), String> {
    if matches!(window.label(), "main" | "overlay") {
        Ok(())
    } else {
        Err("音频流仅供歌词窗口使用".into())
    }
}

#[tauri::command]
pub fn amll_audio_subscribe(
    window: WebviewWindow,
    hub: State<'_, AudioHub>,
    on_audio: Channel,
) -> Result<(), String> {
    require_audio_window(&window)?;
    let mut state = hub.0.lock().map_err(|_| "音频流不可用")?;
    on_audio
        .send(
            AudioPacket::Reset {
                connection_id: state.selected.clone(),
                revision: state.revision,
            }
            .into_body(),
        )
        .map_err(|e| e.to_string())?;
    state.subscribers.insert(
        window.label().into(),
        Subscriber {
            channel: on_audio,
            pending: BTreeSet::new(),
            dropped: 0,
        },
    );
    Ok(())
}

#[tauri::command]
pub fn amll_audio_unsubscribe(
    window: WebviewWindow,
    hub: State<'_, AudioHub>,
) -> Result<(), String> {
    require_audio_window(&window)?;
    hub.0
        .lock()
        .map_err(|_| "音频流不可用")?
        .subscribers
        .remove(window.label());
    Ok(())
}

#[tauri::command]
pub fn amll_audio_ack(
    window: WebviewWindow,
    hub: State<'_, AudioHub>,
    sequence: u64,
) -> Result<(), String> {
    require_audio_window(&window)?;
    if let Some(subscriber) = hub
        .0
        .lock()
        .map_err(|_| "音频流不可用")?
        .subscribers
        .get_mut(window.label())
    {
        subscriber.pending.remove(&sequence);
    }
    Ok(())
}

#[tauri::command]
pub fn amll_audio_select(
    window: WebviewWindow,
    hub: State<'_, AudioHub>,
    connection_id: Option<String>,
) -> Result<(), String> {
    require_audio_window(&window)?;
    if window.label() == "overlay" {
        use tauri::Manager;
        if window
            .app_handle()
            .state::<super::session::Session>()
            .0
            .lock()
            .map_err(|_| "Session unavailable")?
            .control_active
        {
            return Err("The active control window owns the audio source".into());
        }
    }
    if connection_id
        .as_ref()
        .is_some_and(|s| s.len() > 80 || !s.starts_with("amll-"))
    {
        return Err("无效音频来源".into());
    }
    let mut state = hub.0.lock().map_err(|_| "音频流不可用")?;
    if state.selected != connection_id {
        state.selected = connection_id;
        state.reset();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tauri::ipc::InvokeResponseBody;

    #[test]
    fn sources_backpressure_and_discontinuities_are_isolated() {
        let packets = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
        let received = packets.clone();
        let channel = Channel::new(move |message| {
            let packet = match message {
                InvokeResponseBody::Json(json) => serde_json::from_str(&json).unwrap(),
                InvokeResponseBody::Raw(bytes) => {
                    assert_eq!(&bytes[..6], b"LPCM\x01\x02");
                    let source_length =
                        u16::from_le_bytes(bytes[6..8].try_into().unwrap()) as usize;
                    assert_eq!(&bytes[40..40 + source_length], b"amll-1");
                    serde_json::json!({ "type": "pcm",
                        "sequence": u64::from_le_bytes(bytes[16..24].try_into().unwrap()),
                        "droppedFrames": u64::from_le_bytes(bytes[32..40].try_into().unwrap()),
                        "data": bytes[40 + source_length..] })
                }
            };
            received.lock().unwrap().push(packet);
            Ok(())
        });
        let hub = AudioHub::default();
        {
            let mut state = hub.0.lock().unwrap();
            state.selected = Some("amll-1".into());
            state.subscribers.insert(
                "main".into(),
                Subscriber {
                    channel,
                    pending: BTreeSet::new(),
                    dropped: 0,
                },
            );
            state.reset();
        }
        hub.push("amll-2", vec![0, 0, 0, 0], 1);
        assert_eq!(packets.lock().unwrap().len(), 1);
        for _ in 0..10 {
            hub.push("amll-1", vec![0, 128, 255, 127], 2);
        }
        assert_eq!(packets.lock().unwrap().len(), MAX_PENDING + 1);
        hub.0
            .lock()
            .unwrap()
            .subscribers
            .get_mut("main")
            .unwrap()
            .pending
            .clear();
        hub.push("amll-1", vec![0, 128, 255, 127], 2);
        let last = packets.lock().unwrap().last().unwrap().clone();
        assert_eq!(last["droppedFrames"], 6);
        assert_eq!(last["data"], serde_json::json!([0, 128, 255, 127]));
        hub.discontinuity("amll-2", true);
        assert_eq!(hub.0.lock().unwrap().selected.as_deref(), Some("amll-1"));
        hub.discontinuity("amll-1", true);
        assert!(hub.0.lock().unwrap().selected.is_none());
        assert_eq!(packets.lock().unwrap().last().unwrap()["type"], "reset");
    }
}
