//! Windows System Media Transport Controls (SMTC): the "now playing" sessions
//! that media apps publish to Windows (Spotify, browsers, the Windows media
//! flyout). A background thread polls the selected session twice a second and
//! emits `smtc-state` when anything changed; the frontend extrapolates the
//! position between updates. Also the allow-listed HTTP fetch used by the
//! online lyric search (`lyrics_http_get`), through WinRT HttpClient so it
//! follows the system proxy.

use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmtcState {
    /// Whether a media session is selected and readable.
    pub available: bool,
    /// AppUserModelId of the session being read, e.g. `Spotify.exe`.
    pub source: String,
    /// All sessions currently published, in Windows' order.
    pub sessions: Vec<String>,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_artist: String,
    /// Timeline end − start, when the app publishes a timeline.
    pub duration_ms: Option<u64>,
    /// Position at `updated_at_epoch_ms`.
    pub position_ms: u64,
    pub updated_at_epoch_ms: Option<i64>,
    pub playing: bool,
    /// `playing`, `paused`, `stopped`, `changing`, `opened`, `closed`.
    pub status: String,
    pub rate: f64,
    pub error: Option<String>,
}

#[derive(Default)]
struct Inner {
    running: bool,
    generation: u64,
    /// Preferred session; `None` follows Windows' current session.
    selected: Option<String>,
    latest: Option<SmtcState>,
}

#[derive(Default)]
pub struct SmtcHub(Arc<Mutex<Inner>>);

#[tauri::command]
pub fn smtc_start(app: AppHandle, hub: State<'_, SmtcHub>) -> Result<Option<SmtcState>, String> {
    let mut inner = hub.0.lock().map_err(|_| "SMTC unavailable")?;
    if !inner.running {
        inner.running = true;
        inner.generation += 1;
        let generation = inner.generation;
        let shared = hub.0.clone();
        std::thread::Builder::new()
            .name("smtc".into())
            .spawn(move || poll(app, shared, generation))
            .map_err(|e| e.to_string())?;
    }
    Ok(inner.latest.clone())
}

#[tauri::command]
pub fn smtc_stop(hub: State<'_, SmtcHub>) -> Result<(), String> {
    let mut inner = hub.0.lock().map_err(|_| "SMTC unavailable")?;
    inner.running = false;
    inner.latest = None;
    Ok(())
}

#[tauri::command]
pub fn smtc_select(hub: State<'_, SmtcHub>, source: Option<String>) -> Result<(), String> {
    let mut inner = hub.0.lock().map_err(|_| "SMTC unavailable")?;
    inner.selected = source.filter(|s| !s.is_empty());
    Ok(())
}

#[tauri::command]
pub fn smtc_snapshot(hub: State<'_, SmtcHub>) -> Result<Option<SmtcState>, String> {
    Ok(hub.0.lock().map_err(|_| "SMTC unavailable")?.latest.clone())
}

fn poll(app: AppHandle, shared: Arc<Mutex<Inner>>, generation: u64) {
    #[cfg(windows)]
    unsafe {
        let _ = windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_MULTITHREADED);
    }
    let mut reader = platform::Reader::default();
    loop {
        let selected = {
            let Ok(inner) = shared.lock() else { return };
            if !inner.running || inner.generation != generation {
                return;
            }
            inner.selected.clone()
        };
        let state = reader.read(selected.as_deref());
        {
            let Ok(mut inner) = shared.lock() else { return };
            if !inner.running || inner.generation != generation {
                return;
            }
            if inner.latest.as_ref() != Some(&state) {
                inner.latest = Some(state.clone());
                let _ = app.emit("smtc-state", &state);
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
}

#[cfg(windows)]
mod platform {
    use super::SmtcState;
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession as Session,
        GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };

    /// 100 ns ticks between 1601-01-01 (WinRT DateTime) and the Unix epoch.
    const EPOCH_TICKS: i64 = 116_444_736_000_000_000;

    #[derive(Default)]
    pub struct Reader {
        manager: Option<Manager>,
    }

    impl Reader {
        pub fn read(&mut self, selected: Option<&str>) -> SmtcState {
            match self.try_read(selected) {
                Ok(state) => state,
                Err(error) => {
                    // A broken manager (e.g. after explorer restarts) is re-requested next time.
                    self.manager = None;
                    SmtcState { error: Some(error.message().to_string()), ..Default::default() }
                }
            }
        }

        fn try_read(&mut self, selected: Option<&str>) -> windows::core::Result<SmtcState> {
            if self.manager.is_none() {
                self.manager = Some(Manager::RequestAsync()?.join()?);
            }
            let manager = self.manager.as_ref().expect("manager");
            let all = manager.GetSessions()?;
            let mut sessions = Vec::new();
            let mut chosen: Option<Session> = None;
            for session in &all {
                let id = session.SourceAppUserModelId()?.to_string();
                if selected == Some(id.as_str()) {
                    chosen = Some(session.clone());
                }
                sessions.push(id);
            }
            let session = match chosen {
                Some(session) => session,
                None => match manager.GetCurrentSession() {
                    Ok(session) => session,
                    Err(_) => return Ok(SmtcState { sessions, ..Default::default() }),
                },
            };
            let mut state = SmtcState { available: true, sessions, source: session.SourceAppUserModelId()?.to_string(), rate: 1.0, ..Default::default() };
            if let Ok(properties) = session.TryGetMediaPropertiesAsync().and_then(|op| op.join()) {
                state.title = properties.Title().map(|s| s.to_string()).unwrap_or_default();
                state.artist = properties.Artist().map(|s| s.to_string()).unwrap_or_default();
                state.album = properties.AlbumTitle().map(|s| s.to_string()).unwrap_or_default();
                state.album_artist = properties.AlbumArtist().map(|s| s.to_string()).unwrap_or_default();
            }
            if let Ok(info) = session.GetPlaybackInfo() {
                let status = info.PlaybackStatus().unwrap_or(Status::Closed);
                state.playing = status == Status::Playing;
                state.status = match status {
                    Status::Playing => "playing",
                    Status::Paused => "paused",
                    Status::Stopped => "stopped",
                    Status::Changing => "changing",
                    Status::Opened => "opened",
                    _ => "closed",
                }
                .into();
                if let Some(rate) = info.PlaybackRate().ok().and_then(|r| r.Value().ok()) {
                    if rate.is_finite() && rate > 0.0 {
                        state.rate = rate;
                    }
                }
            }
            if let Ok(timeline) = session.GetTimelineProperties() {
                let start = timeline.StartTime().map(|t| t.Duration).unwrap_or(0);
                let end = timeline.EndTime().map(|t| t.Duration).unwrap_or(0);
                let position = timeline.Position().map(|t| t.Duration).unwrap_or(0);
                if end > start {
                    state.duration_ms = Some(((end - start) / 10_000) as u64);
                }
                state.position_ms = (position.saturating_sub(start).max(0) / 10_000) as u64;
                let updated = timeline.LastUpdatedTime().map(|t| t.UniversalTime).unwrap_or(0);
                if updated > EPOCH_TICKS {
                    state.updated_at_epoch_ms = Some((updated - EPOCH_TICKS) / 10_000);
                }
            }
            Ok(state)
        }
    }

    const ALLOWED_HOSTS: [&str; 2] = ["lrclib.net", "music.163.com"];
    const MAX_BODY: usize = 4 * 1024 * 1024;

    pub fn http_get(url: &str) -> Result<String, String> {
        use windows::core::HSTRING;
        use windows::Foundation::Uri;
        use windows::Web::Http::HttpClient;
        let uri = Uri::CreateUri(&HSTRING::from(url)).map_err(|_| "歌词地址无效".to_string())?;
        let scheme = uri.SchemeName().map_err(|e| e.message().to_string())?.to_string();
        let host = uri.Host().map_err(|e| e.message().to_string())?.to_string().to_ascii_lowercase();
        if scheme != "https" || !ALLOWED_HOSTS.contains(&host.as_str()) {
            return Err(format!("不允许访问 {host}"));
        }
        let fetch = || -> windows::core::Result<String> {
            let client = HttpClient::new()?;
            let headers = client.DefaultRequestHeaders()?;
            headers.UserAgent()?.TryParseAdd(&HSTRING::from(concat!("Lyrscape/", env!("CARGO_PKG_VERSION"), " (+https://github.com/Kevin-2106/Lyrscape)")))?;
            if host == "music.163.com" {
                headers.TryAppendWithoutValidation(&HSTRING::from("Referer"), &HSTRING::from("https://music.163.com/"))?;
            }
            Ok(client.GetStringAsync(&uri)?.join()?.to_string())
        };
        let body = fetch().map_err(|e| format!("请求 {host} 失败：{}", e.message()))?;
        if body.len() > MAX_BODY {
            return Err("歌词响应过大".into());
        }
        Ok(body)
    }
}

#[cfg(not(windows))]
mod platform {
    use super::SmtcState;
    #[derive(Default)]
    pub struct Reader;
    impl Reader {
        pub fn read(&mut self, _selected: Option<&str>) -> SmtcState {
            SmtcState { error: Some("SMTC 仅在 Windows 上可用".into()), ..Default::default() }
        }
    }
    pub fn http_get(_url: &str) -> Result<String, String> {
        Err("在线歌词仅在 Windows 桌面版可用".into())
    }
}

/// GET an allow-listed lyric API URL (https://lrclib.net, https://music.163.com).
#[tauri::command]
pub async fn lyrics_http_get(url: String) -> Result<String, String> {
    if url.len() > 2048 {
        return Err("歌词地址过长".into());
    }
    let task = tauri::async_runtime::spawn_blocking(move || {
        #[cfg(windows)]
        unsafe {
            let _ = windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_MULTITHREADED);
        }
        platform::http_get(&url)
    });
    match tokio::time::timeout(std::time::Duration::from_secs(15), task).await {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => Err(error.to_string()),
        Err(_) => Err("在线歌词请求超时".into()),
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::platform;

    /// Reads this machine's current media session; run with `cargo test smtc -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn reads_current_session() {
        unsafe {
            let _ = windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_MULTITHREADED);
        }
        let state = platform::Reader::default().read(None);
        println!("{state:#?}");
        assert!(state.error.is_none(), "{:?}", state.error);
    }

    #[test]
    #[ignore]
    fn fetches_allowed_hosts_only() {
        assert!(platform::http_get("https://example.com/").unwrap_err().contains("不允许"));
        assert!(platform::http_get("http://lrclib.net/api/search?q=a").unwrap_err().contains("不允许"));
        let body = platform::http_get("https://lrclib.net/api/search?track_name=Heavenly%20Me&artist_name=AIYUE").unwrap();
        assert!(body.contains("Heavenly Me"));
    }
}
