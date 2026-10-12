//! Independent implementation of the published AMLL WebSocket wire specification.
//! No AMLL source, codec, or renderer is linked into this crate.
//! Specifications: https://github.com/amll-dev/ws-protocol/blob/b85b04b7da6992544ac813a26a5778be674b62b5/PROTOCOL.md
//! and https://github.com/amll-dev/ws-protocol/blob/b85b04b7da6992544ac813a26a5778be674b62b5/PROTOCOL_V2.md

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const MAX_MESSAGE_BYTES: usize = 2 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 1024 * 1024;
const MAX_LINES: usize = 4096;
const MAX_WORDS: usize = 32768;
const MAX_TIME: u64 = 604_800_000; // Seven days; bounds JS/native timeline arithmetic.

#[derive(Debug)]
pub enum Decoded {
    Payload(Value),
    Ping,
    Pong,
    Initialize,
    Ignored,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Artist {
    id: String,
    name: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Word {
    start_time: u64,
    end_time: u64,
    word: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    roman_word: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Line {
    start_time: u64,
    end_time: u64,
    words: Vec<Word>,
    #[serde(default)]
    translated_lyric: String,
    #[serde(default)]
    roman_lyric: String,
    #[serde(default, rename = "isBG")]
    is_bg: bool,
    #[serde(default)]
    is_duet: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "update", rename_all = "camelCase")]
enum StateUpdate {
    #[serde(rename_all = "camelCase")]
    SetMusic {
        music_id: String,
        music_name: String,
        #[serde(default)]
        album_id: String,
        #[serde(default)]
        album_name: String,
        #[serde(default)]
        artists: Vec<Artist>,
        duration: u64,
    },
    Progress {
        progress: u64,
    },
    Volume {
        volume: f64,
    },
    Paused,
    Resumed,
    #[serde(rename_all = "camelCase")]
    SetLyric {
        #[serde(flatten)]
        content: LyricContent,
    },
    #[serde(rename_all = "camelCase")]
    ModeChanged {
        repeat: RepeatMode,
        shuffle: bool,
    },
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum RepeatMode {
    Off,
    All,
    One,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "format", rename_all = "lowercase")]
enum LyricContent {
    Structured { lines: Vec<Line> },
    Ttml { data: String },
}

impl StateUpdate {
    fn validate(&self) -> Result<(), String> {
        match self {
            Self::SetMusic {
                music_id,
                music_name,
                album_id,
                album_name,
                artists,
                duration,
            } => {
                for value in [music_id, music_name, album_id, album_name] {
                    bounded_string(value, 4096)?;
                }
                if artists.len() > 128 {
                    return Err("Too many artists".into());
                }
                for artist in artists {
                    bounded_string(&artist.id, 4096)?;
                    bounded_string(&artist.name, 4096)?;
                }
                bounded_time(*duration)?;
            }
            Self::Progress { progress } => bounded_time(*progress)?,
            Self::Volume { volume } => {
                if !volume.is_finite() || !(0.0..=1.0).contains(volume) {
                    return Err("Volume must be between zero and one".into());
                }
            }
            Self::SetLyric {
                content: LyricContent::Ttml { data },
            } => bounded_string(data, MAX_TEXT_BYTES)?,
            Self::SetLyric {
                content: LyricContent::Structured { lines },
            } => {
                if lines.len() > MAX_LINES {
                    return Err("Too many lyric lines".into());
                }
                let word_count: usize = lines.iter().map(|line| line.words.len()).sum();
                if word_count > MAX_WORDS {
                    return Err("Too many lyric words".into());
                }
                for line in lines {
                    bounded_interval(line.start_time, line.end_time)?;
                    bounded_string(&line.translated_lyric, 16 * 1024)?;
                    bounded_string(&line.roman_lyric, 16 * 1024)?;
                    for word in &line.words {
                        bounded_interval(word.start_time, word.end_time)?;
                        bounded_string(&word.word, 16 * 1024)?;
                        if let Some(roman) = &word.roman_word {
                            bounded_string(roman, 16 * 1024)?;
                        }
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn payload(self) -> Result<Decoded, String> {
        self.validate()?;
        Ok(Decoded::Payload(json!({ "type": "state", "value": self })))
    }
}

fn bounded_string(value: &str, max: usize) -> Result<(), String> {
    if value.len() > max {
        Err("Text exceeds the broker limit".into())
    } else {
        Ok(())
    }
}

fn bounded_time(value: u64) -> Result<(), String> {
    if value > MAX_TIME {
        Err("Time exceeds the broker limit".into())
    } else {
        Ok(())
    }
}

fn bounded_interval(start: u64, end: u64) -> Result<(), String> {
    bounded_time(start)?;
    bounded_time(end)?;
    if end < start {
        Err("Lyric end time precedes start time".into())
    } else {
        Ok(())
    }
}

pub fn decode_v2(text: &str) -> Result<Decoded, String> {
    if text.len() > MAX_MESSAGE_BYTES {
        return Err("Message exceeds the broker limit".into());
    }
    let value: Value = serde_json::from_str(text).map_err(|_| "Invalid AMLL JSON".to_owned())?;
    match value.get("type").and_then(Value::as_str) {
        Some("initialize") => Ok(Decoded::Initialize),
        Some("ping") => Ok(Decoded::Ping),
        Some("pong") => Ok(Decoded::Pong),
        Some("state") => {
            let state = value.get("value").ok_or("AMLL state requires a value")?;
            // Baseline renderer does not consume covers or PCM. Never forward raw bytes into webviews.
            if matches!(
                state.get("update").and_then(Value::as_str),
                Some("setCover" | "audioData")
            ) {
                return Ok(Decoded::Ignored);
            }
            let state: StateUpdate = serde_json::from_value(state.clone())
                .map_err(|_| "Invalid or unsupported AMLL state update".to_owned())?;
            state.payload()
        }
        Some("command") => Ok(Decoded::Ignored), // The initial adapter is read-only.
        _ => Err("Unknown AMLL payload type".into()),
    }
}

struct Reader<'a> {
    data: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, count: usize) -> Result<&'a [u8], String> {
        let end = self.offset.checked_add(count).ok_or("Invalid V1 length")?;
        let bytes = self
            .data
            .get(self.offset..end)
            .ok_or("Truncated AMLL V1 message")?;
        self.offset = end;
        Ok(bytes)
    }
    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16, String> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }
    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn u64(&mut self) -> Result<u64, String> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn f64(&mut self) -> Result<f64, String> {
        Ok(f64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn count(&mut self, max: usize) -> Result<usize, String> {
        let count = self.u32()? as usize;
        if count > max {
            return Err("V1 list exceeds the broker limit".into());
        }
        Ok(count)
    }
    fn string(&mut self, max: usize) -> Result<String, String> {
        let remaining = &self.data[self.offset..];
        let len = remaining
            .iter()
            .position(|byte| *byte == 0)
            .ok_or("Unterminated AMLL V1 string")?;
        if len > max {
            return Err("V1 string exceeds the broker limit".into());
        }
        let value = std::str::from_utf8(self.take(len)?)
            .map_err(|_| "Invalid AMLL V1 UTF-8")?
            .to_owned();
        self.take(1)?;
        Ok(value)
    }
    fn skip_blob(&mut self) -> Result<(), String> {
        let len = self.count(MAX_MESSAGE_BYTES)?;
        self.take(len)?;
        Ok(())
    }
    fn finish(&self) -> Result<(), String> {
        if self.offset == self.data.len() {
            Ok(())
        } else {
            Err("Trailing bytes in AMLL V1 message".into())
        }
    }
}

pub fn decode_v1(data: &[u8]) -> Result<Decoded, String> {
    if data.len() > MAX_MESSAGE_BYTES {
        return Err("Message exceeds the broker limit".into());
    }
    let mut reader = Reader { data, offset: 0 };
    let magic = reader.u16()?;
    let output = match magic {
        0 => Decoded::Ping,
        1 => Decoded::Pong,
        2 => {
            let music_id = reader.string(4096)?;
            let music_name = reader.string(4096)?;
            let album_id = reader.string(4096)?;
            let album_name = reader.string(4096)?;
            let count = reader.count(128)?;
            let mut artists = Vec::with_capacity(count);
            for _ in 0..count {
                artists.push(Artist {
                    id: reader.string(4096)?,
                    name: reader.string(4096)?,
                });
            }
            let duration = reader.u64()?;
            StateUpdate::SetMusic {
                music_id,
                music_name,
                album_id,
                album_name,
                artists,
                duration,
            }
            .payload()?
        }
        3 => {
            reader.string(MAX_TEXT_BYTES)?;
            Decoded::Ignored
        }
        4 | 9 => {
            reader.skip_blob()?;
            Decoded::Ignored
        }
        5 => StateUpdate::Progress {
            progress: reader.u64()?,
        }
        .payload()?,
        6 => StateUpdate::Volume {
            volume: reader.f64()?,
        }
        .payload()?,
        7 => StateUpdate::Paused.payload()?,
        8 => StateUpdate::Resumed.payload()?,
        10 => {
            let count = reader.count(MAX_LINES)?;
            let mut lines = Vec::with_capacity(count);
            let mut remaining_words = MAX_WORDS;
            for _ in 0..count {
                let start_time = reader.u64()?;
                let end_time = reader.u64()?;
                let word_count = reader.count(remaining_words)?;
                remaining_words -= word_count;
                let mut words = Vec::with_capacity(word_count);
                for _ in 0..word_count {
                    words.push(Word {
                        start_time: reader.u64()?,
                        end_time: reader.u64()?,
                        word: reader.string(16 * 1024)?,
                        roman_word: None,
                    });
                }
                let translated_lyric = reader.string(16 * 1024)?;
                let roman_lyric = reader.string(16 * 1024)?;
                let flags = reader.u8()?;
                lines.push(Line {
                    start_time,
                    end_time,
                    words,
                    translated_lyric,
                    roman_lyric,
                    is_bg: flags & 1 != 0,
                    is_duet: flags & 2 != 0,
                });
            }
            StateUpdate::SetLyric {
                content: LyricContent::Structured { lines },
            }
            .payload()?
        }
        11 => StateUpdate::SetLyric {
            content: LyricContent::Ttml {
                data: reader.string(MAX_TEXT_BYTES)?,
            },
        }
        .payload()?,
        // Client-to-player commands are parsed only for frame integrity, then ignored.
        12..=15 => Decoded::Ignored,
        16 => {
            reader.f64()?;
            Decoded::Ignored
        }
        17 => {
            reader.u64()?;
            Decoded::Ignored
        }
        _ => return Err("Unknown AMLL V1 magic number".into()),
    };
    reader.finish()?;
    Ok(output)
}

pub fn validate_v2_binary(data: &[u8]) -> Result<Decoded, String> {
    // Version is locked on the first data frame; overlapping V1 magic values are never guessed.
    let mut reader = Reader { data, offset: 0 };
    match reader.u16()? {
        0 | 1 => reader.skip_blob()?,
        _ => return Err("Unknown AMLL V2 binary channel".into()),
    }
    reader.finish()?;
    Ok(Decoded::Ignored)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(decoded: Decoded) -> Value {
        match decoded {
            Decoded::Payload(value) => value,
            _ => panic!("Expected state"),
        }
    }

    #[test]
    fn v1_progress_has_v2_shape() {
        let mut bytes = vec![5, 0];
        bytes.extend(1234u64.to_le_bytes());
        assert_eq!(
            payload(decode_v1(&bytes).unwrap()),
            json!({"type":"state","value":{"update":"progress","progress":1234}})
        );
        bytes.push(0);
        assert!(decode_v1(&bytes).is_err());
    }

    #[test]
    fn v1_metadata_and_v2_roundtrip_preserve_canonical_names() {
        let mut bytes = vec![2, 0];
        bytes.extend(b"id\0Title\0album\0Album\0");
        bytes.extend(1u32.to_le_bytes());
        bytes.extend(b"artist-id\0Artist\0");
        bytes.extend(300_000u64.to_le_bytes());
        let state = payload(decode_v1(&bytes).unwrap());
        assert_eq!(state["value"]["musicName"], "Title");
        assert_eq!(state["value"]["duration"], 300_000);
        assert_eq!(payload(decode_v2(&state.to_string()).unwrap()), state);
    }

    #[test]
    fn ttml_is_forwarded_as_data_without_native_parsing_or_markup_execution() {
        let text = "<tt xmlns=\"http://www.w3.org/ns/ttml\"><body/></tt>";
        let mut bytes = vec![11, 0];
        bytes.extend(text.as_bytes());
        bytes.push(0);
        let state = payload(decode_v1(&bytes).unwrap());
        assert_eq!(state["value"]["format"], "ttml");
        assert_eq!(state["value"]["data"], text);
        assert_eq!(payload(decode_v2(&state.to_string()).unwrap()), state);
    }

    #[test]
    fn v1_decodes_unicode_lyrics_and_flags() {
        let mut bytes = vec![10, 0];
        bytes.extend(1u32.to_le_bytes());
        bytes.extend(1000u64.to_le_bytes());
        bytes.extend(2000u64.to_le_bytes());
        bytes.extend(1u32.to_le_bytes());
        bytes.extend(1000u64.to_le_bytes());
        bytes.extend(2000u64.to_le_bytes());
        bytes.extend("逐字\0translation\0roman\0".as_bytes());
        bytes.push(3);
        let result = payload(decode_v1(&bytes).unwrap());
        assert_eq!(result["value"]["lines"][0]["words"][0]["word"], "逐字");
        assert_eq!(result["value"]["lines"][0]["isBG"], true);
        assert_eq!(result["value"]["lines"][0]["isDuet"], true);
        for prefix in 0..bytes.len() {
            assert!(decode_v1(&bytes[..prefix]).is_err());
        }
    }

    #[test]
    fn malicious_lengths_and_invalid_intervals_are_rejected() {
        assert!(decode_v1(&[10, 0, 255, 255, 255, 255]).is_err());
        let message = r#"{"type":"state","value":{"update":"setLyric","format":"structured","lines":[{"startTime":1000,"endTime":500,"words":[]}]}}"#;
        assert!(decode_v2(message).is_err());
        assert!(
            decode_v2(r#"{"type":"state","value":{"update":"progress","progress":-1}}"#).is_err()
        );
    }

    #[test]
    fn protocol_version_is_explicit_and_binary_ignored_safely() {
        assert!(matches!(
            decode_v2(r#"{"type":"initialize"}"#).unwrap(),
            Decoded::Initialize
        ));
        assert!(matches!(decode_v1(&[0, 0]).unwrap(), Decoded::Ping));
        assert!(validate_v2_binary(&[0, 0]).is_err());
        assert!(matches!(
            validate_v2_binary(&[0, 0, 1, 0, 0, 0, 42]).unwrap(),
            Decoded::Ignored
        ));
    }
}
