use serde::Serialize;
use std::{fs, io::Read, path::Path};
use tauri::WebviewWindow;

const MAX_CATALOG: usize = 128;
const MAX_JS: u64 = 2 * 1024 * 1024;
const MAX_CSS: u64 = 512 * 1024;

#[derive(Debug, Serialize)]
pub struct PluginSource {
    id: String,
    javascript: String,
    css: String,
}

fn read_file(root: &Path, name: &str, limit: u64) -> Result<String, String> {
    let path = root
        .join(name)
        .canonicalize()
        .map_err(|_| format!("找不到本地插件文件：plugins/{name}"))?;
    if !path.starts_with(root) {
        return Err("插件文件不能链接到 plugins 目录之外".into());
    }
    let file = fs::File::open(&path).map_err(|e| e.to_string())?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("插件路径必须是普通文件".into());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit {
        return Err(format!("插件文件超过大小上限：{name}"));
    }
    String::from_utf8(bytes).map_err(|_| "插件文件必须使用 UTF-8".into())
}

/// Dotted lowercase plugin IDs (same rule as the frontend `PLUGIN_ID`); they double as file names.
fn valid_id(id: &str) -> bool {
    let parts: Vec<&str> = id.split('.').collect();
    id.len() <= 96
        && (2..=6).contains(&parts.len())
        && parts.iter().all(|part| {
            let mut chars = part.chars();
            matches!(chars.next(), Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit())
                && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        })
}

fn plugins_root(directory: &Path) -> Result<std::path::PathBuf, String> {
    let base = directory.canonicalize().map_err(|e| e.to_string())?;
    let root = base
        .join("plugins")
        .canonicalize()
        .map_err(|_| "请先生成 exe 旁的 plugins 目录（npm run plugins:build）".to_owned())?;
    if !root.starts_with(&base) {
        return Err("plugins 目录不能链接到 exe 目录之外".into());
    }
    Ok(root)
}

/// IDs of the regular `<id>.mjs` files in the plugins folder, sorted.
fn list_catalog(directory: &Path) -> Result<Vec<String>, String> {
    let root = plugins_root(directory)?;
    let mut ids = Vec::new();
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_file() {
            continue;
        }
        let name = entry.file_name();
        let Some(id) = name.to_str().and_then(|name| name.strip_suffix(".mjs")) else {
            continue;
        };
        if valid_id(id) {
            ids.push(id.to_owned());
        }
    }
    ids.sort();
    if ids.len() > MAX_CATALOG {
        return Err(format!("plugins 目录中的插件超过 {MAX_CATALOG} 个"));
    }
    Ok(ids)
}

fn read_source(directory: &Path, id: &str) -> Result<PluginSource, String> {
    if !valid_id(id) {
        return Err("插件 ID 无效".into());
    }
    let root = plugins_root(directory)?;
    let javascript = read_file(&root, &format!("{id}.mjs"), MAX_JS)?;
    let css_name = format!("{id}.css");
    let css = if root.join(&css_name).exists() {
        read_file(&root, &css_name, MAX_CSS)?
    } else {
        String::new()
    };
    Ok(PluginSource {
        id: id.into(),
        javascript,
        css,
    })
}

#[tauri::command]
pub fn plugin_source(window: WebviewWindow, id: String) -> Result<PluginSource, String> {
    super::require_control(&window)?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    read_source(exe.parent().ok_or("无法找到 exe 目录")?, &id)
}

#[tauri::command]
pub fn plugin_catalog(window: WebviewWindow) -> Result<Vec<String>, String> {
    super::require_control(&window)?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    list_catalog(exe.parent().ok_or("无法找到 exe 目录")?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn malformed_ids_and_paths_are_rejected_before_reading() {
        for id in [
            "../secrets",
            "plugin",
            "",
            "official.renderer.aurora/../other",
            "Official.renderer.x",
            "a..b",
            "a.b\\c",
        ] {
            assert!(read_source(Path::new("."), id)
                .unwrap_err()
                .contains("无效"));
        }
        assert!(valid_id("official.renderer.pv-halo"));
        assert!(valid_id("local.renderer.my-style2"));
    }
    #[test]
    fn catalog_lists_only_valid_plugin_files() {
        let base =
            std::env::temp_dir().join(format!("lyrscape-plugin-catalog-{}", std::process::id()));
        let root = base.join("plugins");
        fs::create_dir_all(root.join("dir.renderer.x.mjs")).unwrap();
        for name in [
            "b.renderer.two.mjs",
            "a.renderer.one.mjs",
            "a.renderer.one.css",
            "Bad.Name.mjs",
            "notes.txt",
        ] {
            fs::write(root.join(name), b"export default {};").unwrap();
        }
        assert_eq!(
            list_catalog(&base).unwrap(),
            vec!["a.renderer.one", "b.renderer.two"]
        );
        fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn byte_budget_and_utf8_are_enforced() {
        let root =
            std::env::temp_dir().join(format!("lyrscape-plugin-source-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let file = root.join("fixture.mjs");
        fs::write(&file, b"export default {};").unwrap();
        assert!(read_file(&root, "fixture.mjs", 4).is_err());
        assert_eq!(
            read_file(&root, "fixture.mjs", 100).unwrap(),
            "export default {};"
        );
        fs::write(&file, [0xff]).unwrap();
        assert!(read_file(&root, "fixture.mjs", 100).is_err());
        fs::remove_file(file).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
