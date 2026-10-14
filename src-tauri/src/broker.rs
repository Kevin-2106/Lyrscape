use crate::amll_protocol::{self, Decoded, MAX_MESSAGE_BYTES};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::BTreeSet,
    net::{Ipv4Addr, SocketAddr},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::{watch, Mutex as AsyncMutex},
    task::JoinSet,
    time::timeout,
};
use tokio_tungstenite::{
    accept_hdr_async_with_config,
    tungstenite::{
        handshake::server::{Request, Response},
        http,
        protocol::{Message, WebSocketConfig},
    },
};

const MAX_CLIENTS: usize = 4;
const MAX_MESSAGES_PER_SECOND: usize = 240;
const MAX_BYTES_PER_SECOND: usize = 8 * 1024 * 1024;
const NEGOTIATION_TIMEOUT: Duration = Duration::from_secs(10);
const WRITE_TIMEOUT: Duration = Duration::from_secs(2);
static NEXT_CONNECTION: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Default)]
pub struct Broker {
    running: Arc<AsyncMutex<Option<Running>>>,
}

struct Running {
    port: u16,
    shutdown: watch::Sender<bool>,
    task: tauri::async_runtime::JoinHandle<()>,
    connections: Arc<Mutex<BTreeSet<String>>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerStatus {
    pub running: bool,
    pub port: Option<u16>,
    pub connections: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionEvent {
    connection_id: String,
    connected: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MessageEvent {
    connection_id: String,
    payload: Value,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorEvent {
    connection_id: Option<String>,
    message: String,
}

fn report_error(app: &AppHandle, id: Option<&str>, message: impl Into<String>) {
    let _ = app.emit(
        "amll-error",
        ErrorEvent {
            connection_id: id.map(str::to_owned),
            message: message.into(),
        },
    );
}

impl Broker {
    pub async fn status(&self) -> BrokerStatus {
        let running = self.running.lock().await;
        match running.as_ref() {
            Some(running) => BrokerStatus {
                running: !running.task.inner().is_finished(),
                port: Some(running.port),
                connections: running
                    .connections
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .iter()
                    .cloned()
                    .collect(),
            },
            None => BrokerStatus {
                running: false,
                port: None,
                connections: Vec::new(),
            },
        }
    }

    pub async fn start(
        &self,
        app: AppHandle,
        port: u16,
        allowed_origins: Option<Vec<String>>,
    ) -> Result<BrokerStatus, String> {
        if port == 0 {
            return Err("AMLL port must be between 1 and 65535".into());
        }
        let origins = Arc::new(validate_origins(allowed_origins)?);
        let mut running = self.running.lock().await;
        if let Some(current) = running.as_ref() {
            if !current.task.inner().is_finished() {
                if current.port == port {
                    return Ok(BrokerStatus {
                        running: true,
                        port: Some(port),
                        connections: current
                            .connections
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .iter()
                            .cloned()
                            .collect(),
                    });
                }
                return Err("Stop the current AMLL listener before changing its port".into());
            }
        }
        let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
        let listener = TcpListener::bind(address)
            .await
            .map_err(|e| format!("Cannot listen on ws://{address}: {e}"))?;
        let (shutdown, stop) = watch::channel(false);
        let connections = Arc::new(Mutex::new(BTreeSet::new()));
        let task =
            tauri::async_runtime::spawn(serve(app, listener, stop, connections.clone(), origins));
        *running = Some(Running {
            port,
            shutdown,
            task,
            connections,
        });
        Ok(BrokerStatus {
            running: true,
            port: Some(port),
            connections: Vec::new(),
        })
    }

    pub async fn stop(&self) -> Result<BrokerStatus, String> {
        // Keep the lifecycle lock while closing sockets, so a new listener cannot race old callbacks.
        let mut running = self.running.lock().await;
        if let Some(current) = running.take() {
            let _ = current.shutdown.send(true);
            let _ = current.task.await;
        }
        Ok(BrokerStatus {
            running: false,
            port: None,
            connections: Vec::new(),
        })
    }

    pub fn shutdown_on_exit(&self) {
        if let Ok(mut running) = self.running.try_lock() {
            if let Some(current) = running.take() {
                let _ = current.shutdown.send(true);
                current.task.abort();
            }
        }
    }
}

fn validate_origins(origins: Option<Vec<String>>) -> Result<Vec<String>, String> {
    let origins = origins.unwrap_or_else(|| {
        vec![
            "https://music.163.com".into(),
            "https://y.qq.com".into(),
            "https://amll.dev".into(),
            // Observed from the actual NetEase desktop AMLL Connector WebView.
            "orpheus://orpheus".into(),
        ]
    });
    if origins.len() > 16 {
        return Err("At most 16 browser origins are allowed".into());
    }
    for origin in &origins {
        if origin == "orpheus://orpheus" {
            continue;
        }
        if origin.len() > 256 {
            return Err("Browser origin is too long".into());
        }
        let uri: http::Uri = origin.parse().map_err(|_| "Invalid browser origin")?;
        if !matches!(uri.scheme_str(), Some("http" | "https" | "tauri"))
            || uri.authority().is_none()
            || uri.path() != "/"
            || uri.query().is_some()
            || origin.contains('@')
        {
            return Err("Browser origins must be exact http(s)/tauri scheme and host pairs, or the supported NetEase desktop origin".into());
        }
    }
    Ok(origins)
}

fn origin_allowed(origin: &str, configured: &[String]) -> bool {
    if configured.iter().any(|allowed| allowed == origin) {
        return true;
    }
    let Ok(uri) = origin.parse::<http::Uri>() else {
        return false;
    };
    matches!(uri.scheme_str(), Some("http" | "https" | "tauri"))
        && matches!(
            uri.host(),
            Some("localhost" | "127.0.0.1" | "[::1]" | "tauri.localhost")
        )
        && uri.path() == "/"
        && uri.query().is_none()
        && !origin.contains('@')
}

async fn serve(
    app: AppHandle,
    listener: TcpListener,
    mut stop: watch::Receiver<bool>,
    connections: Arc<Mutex<BTreeSet<String>>>,
    origins: Arc<Vec<String>>,
) {
    let mut clients = JoinSet::new();
    loop {
        tokio::select! {
            biased;
            _ = stop.changed() => break,
            _ = clients.join_next(), if !clients.is_empty() => {},
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, peer)) => {
                        if !peer.ip().is_loopback() || clients.len() >= MAX_CLIENTS {
                            drop(stream);
                            continue;
                        }
                        let app = app.clone();
                        let stop = stop.clone();
                        let connections = connections.clone();
                        let origins = origins.clone();
                        clients.spawn(async move { client(app, stream, stop, connections, origins).await });
                    }
                    Err(error) => {
                        report_error(&app, None, format!("AMLL accept failed: {error}"));
                        break;
                    }
                }
            }
        }
    }
    // Drop the listening socket before waiting for clients so the port is released immediately.
    drop(listener);
    clients.abort_all();
    while clients.join_next().await.is_some() {}
}

struct ConnectionGuard {
    app: AppHandle,
    id: String,
    connections: Arc<Mutex<BTreeSet<String>>>,
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        self.app
            .state::<crate::audio::AudioHub>()
            .discontinuity(&self.id, true);
        self.connections
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.id);
        let _ = self.app.emit(
            "amll-connection",
            ConnectionEvent {
                connection_id: self.id.clone(),
                connected: false,
            },
        );
    }
}

#[derive(Clone, Copy)]
enum Version {
    V1,
    V2,
}

async fn client(
    app: AppHandle,
    stream: TcpStream,
    mut stop: watch::Receiver<bool>,
    connections: Arc<Mutex<BTreeSet<String>>>,
    origins: Arc<Vec<String>>,
) {
    let id = format!("amll-{}", NEXT_CONNECTION.fetch_add(1, Ordering::Relaxed));
    let mut config = WebSocketConfig::default();
    config.max_message_size = Some(MAX_MESSAGE_BYTES);
    config.max_frame_size = Some(MAX_MESSAGE_BYTES);
    config.max_write_buffer_size = 64 * 1024;
    config.write_buffer_size = 16 * 1024;
    let rejected_origin: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let rejection = rejected_origin.clone();
    let callback = move |request: &Request, response: Response| {
        if let Some(origin) = request.headers().get("Origin") {
            if !origin
                .to_str()
                .is_ok_and(|origin| origin_allowed(origin, &origins))
            {
                let diagnostic = origin
                    .to_str()
                    .map(|origin| origin.chars().take(256).collect())
                    .unwrap_or_else(|_| "<invalid UTF-8>".to_owned());
                *rejection.lock().unwrap_or_else(|error| error.into_inner()) = Some(diagnostic);
                return Err(http::Response::builder()
                    .status(403)
                    .body(Some("Origin is not allowed by Lyrscape".into()))
                    .unwrap());
            }
        }
        Ok(response)
    };
    let handshake = timeout(
        NEGOTIATION_TIMEOUT,
        accept_hdr_async_with_config(stream, callback, Some(config)),
    );
    let mut socket = tokio::select! {
        _ = stop.changed() => return,
        result = handshake => match result {
            Ok(Ok(socket)) => socket,
            Ok(Err(error)) => {
                let origin = rejected_origin.lock().unwrap_or_else(|error| error.into_inner()).take();
                let message = match origin {
                    Some(origin) => format!("AMLL browser Origin is not allowed: {origin}"),
                    None => format!("WebSocket handshake rejected: {error}"),
                };
                report_error(&app, Some(&id), message);
                return;
            },
            Err(_) => { report_error(&app, Some(&id), "WebSocket handshake timed out"); return; },
        }
    };
    connections
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id.clone());
    let _guard = ConnectionGuard {
        app: app.clone(),
        id: id.clone(),
        connections,
    };
    let _ = app.emit(
        "amll-connection",
        ConnectionEvent {
            connection_id: id.clone(),
            connected: true,
        },
    );
    let mut version = None;
    let first_deadline = tokio::time::Instant::now() + NEGOTIATION_TIMEOUT;
    let mut rate_start = Instant::now();
    let mut rate_count = 0;
    let mut rate_bytes = 0;
    loop {
        let incoming = tokio::select! {
            biased;
            _ = stop.changed() => break,
            _ = tokio::time::sleep_until(first_deadline), if version.is_none() => {
                report_error(&app, Some(&id), "AMLL sender did not initialize within ten seconds");
                break;
            }
            result = socket.next() => match result {
                Some(Ok(message)) => message,
                Some(Err(error)) => { report_error(&app, Some(&id), format!("AMLL connection failed: {error}")); break; },
                None => break,
            }
        };
        if rate_start.elapsed() >= Duration::from_secs(1) {
            rate_start = Instant::now();
            rate_count = 0;
            rate_bytes = 0;
        }
        rate_count += 1;
        rate_bytes += incoming.len();
        if rate_count > MAX_MESSAGES_PER_SECOND {
            report_error(
                &app,
                Some(&id),
                "AMLL sender exceeded 240 messages per second",
            );
            break;
        }
        if rate_bytes > MAX_BYTES_PER_SECOND {
            report_error(&app, Some(&id), "AMLL sender exceeded 8 MiB per second");
            break;
        }
        let decoded = match incoming {
            Message::Close(_) => break,
            Message::Ping(data) => {
                if !matches!(
                    timeout(WRITE_TIMEOUT, socket.send(Message::Pong(data))).await,
                    Ok(Ok(()))
                ) {
                    break;
                }
                continue;
            }
            Message::Pong(_) => continue,
            Message::Text(text) => match version {
                None => match amll_protocol::decode_v2(&text) {
                    Ok(Decoded::Initialize) => {
                        version = Some(Version::V2);
                        Ok(Decoded::Initialize)
                    }
                    _ => Err("The first AMLL V2 message must be initialize".into()),
                },
                Some(Version::V2) => amll_protocol::decode_v2(&text),
                Some(Version::V1) => Err("A V1 connection cannot switch to text messages".into()),
            },
            Message::Binary(data) => match version {
                None => {
                    version = Some(Version::V1);
                    amll_protocol::decode_v1(&data)
                }
                Some(Version::V1) => amll_protocol::decode_v1(&data),
                Some(Version::V2) => amll_protocol::validate_v2_binary(&data),
            },
            Message::Frame(_) => continue,
        };
        match decoded {
            Ok(Decoded::Payload(payload)) => {
                if matches!(
                    payload.pointer("/value/update").and_then(Value::as_str),
                    Some("setMusic" | "paused")
                ) {
                    app.state::<crate::audio::AudioHub>()
                        .discontinuity(&id, false);
                }
                let _ = app.emit(
                    "amll-message",
                    MessageEvent {
                        connection_id: id.clone(),
                        payload,
                    },
                );
            }
            Ok(Decoded::Pcm(data)) => app.state::<crate::audio::AudioHub>().push(
                &id,
                data,
                if matches!(version, Some(Version::V1)) {
                    1
                } else {
                    2
                },
            ),
            Ok(Decoded::Ping) => {
                let pong = match version {
                    Some(Version::V1) => Message::Binary(vec![1, 0].into()),
                    _ => Message::Text("{\"type\":\"pong\"}".into()),
                };
                if !matches!(timeout(WRITE_TIMEOUT, socket.send(pong)).await, Ok(Ok(()))) {
                    break;
                }
            }
            Ok(_) => {}
            Err(message) => {
                report_error(&app, Some(&id), message);
                break;
            }
        }
    }
    let _ = timeout(WRITE_TIMEOUT, socket.close(None)).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins_are_exact_and_arbitrary_browser_sites_are_denied() {
        let configured = validate_origins(None).unwrap();
        assert!(origin_allowed("http://localhost:1420", &configured));
        assert!(origin_allowed("http://tauri.localhost", &configured));
        assert!(origin_allowed("https://music.163.com", &configured));
        assert!(!origin_allowed(
            "https://music.163.com.attacker.test",
            &configured
        ));
        assert!(!origin_allowed("https://attacker.test", &configured));
        assert!(!origin_allowed(
            "http://localhost@attacker.test",
            &configured
        ));
        assert!(validate_origins(Some(vec!["https://example.com/path".into()])).is_err());
    }

    #[test]
    fn native_netease_connector_origin_is_allowed_exactly() {
        let defaults = validate_origins(None).unwrap();
        assert!(origin_allowed("orpheus://orpheus", &defaults));
        assert!(!origin_allowed("orpheus://attacker", &defaults));
        assert!(!origin_allowed("orpheus://orpheus/path", &defaults));
        assert!(validate_origins(Some(vec!["orpheus://orpheus".into()])).is_ok());
        assert!(validate_origins(Some(vec!["orpheus://attacker".into()])).is_err());
        assert!(validate_origins(Some(vec!["orpheus://orpheus/path".into()])).is_err());
    }
}
