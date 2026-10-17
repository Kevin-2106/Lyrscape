use serde::Serialize;
use std::{fs, io::Read, path::Path};
use tauri::{Manager, WebviewWindow};

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
        .map_err(|_| "插件文件夹不存在：先导入插件，或运行 npm run plugins:build".to_owned())?;
    if !root.starts_with(&base) {
        return Err("plugins 目录不能链接到所在目录之外".into());
    }
    Ok(root)
}

/// The plugins folder, created when missing (install target).
fn ensure_root(directory: &Path) -> Result<std::path::PathBuf, String> {
    fs::create_dir_all(directory.join("plugins"))
        .map_err(|e| format!("无法创建 plugins 目录：{e}"))?;
    plugins_root(directory)
}

/// IDs of the regular `<id>.mjs` files in the plugins folder, sorted. No folder means no installed plugins.
fn list_catalog(directory: &Path) -> Result<Vec<String>, String> {
    if !directory.join("plugins").exists() {
        return Ok(Vec::new());
    }
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

fn write_plugin(directory: &Path, id: &str, javascript: &str, css: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err("插件 ID 无效".into());
    }
    if javascript.len() as u64 > MAX_JS || css.len() as u64 > MAX_CSS {
        return Err("插件文件超过大小上限".into());
    }
    let root = ensure_root(directory)?;
    if list_catalog(directory)?.len() >= MAX_CATALOG && !root.join(format!("{id}.mjs")).exists() {
        return Err(format!("plugins 目录中的插件超过 {MAX_CATALOG} 个"));
    }
    // Write beside the target and rename, so a running scan never reads half a module.
    let write = |name: String, contents: &str| -> Result<(), String> {
        let target = root.join(&name);
        if target.exists()
            && !fs::symlink_metadata(&target)
                .map_err(|e| e.to_string())?
                .is_file()
        {
            return Err("插件路径必须是普通文件".into());
        }
        let staging = root.join(format!(".{name}.partial"));
        fs::write(&staging, contents).map_err(|e| e.to_string())?;
        fs::rename(&staging, &target).map_err(|e| {
            let _ = fs::remove_file(&staging);
            e.to_string()
        })
    };
    let css_path = root.join(format!("{id}.css"));
    if css.is_empty() {
        if css_path.exists() {
            fs::remove_file(&css_path).map_err(|e| e.to_string())?;
        }
    } else {
        write(format!("{id}.css"), css)?;
    }
    write(format!("{id}.mjs"), javascript)
}

fn remove_plugin(directory: &Path, id: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err("插件 ID 无效".into());
    }
    let root = plugins_root(directory)?;
    for name in [format!("{id}.mjs"), format!("{id}.css")] {
        let path = root.join(name);
        if path.exists() {
            fs::remove_file(path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// `<name>.lyrx` with no path parts; anything else is refused.
fn valid_export_name(name: &str) -> bool {
    name.len() <= 120
        && name.ends_with(".lyrx")
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

fn exe_directory() -> Result<std::path::PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    Ok(exe.parent().ok_or("无法找到 exe 目录")?.to_owned())
}

/// The directory that holds `plugins/`. A `plugins` folder beside the exe wins
/// (portable copies and development builds, see `npm run plugins:build`); an
/// installed app keeps plugins in its per-user data folder, which is always
/// writable, survives updates and goes with 「删除应用数据」 on uninstall.
/// `LYRSCAPE_DATA_DIR` overrides both (isolated test instances).
fn storage_base(window: &WebviewWindow) -> Result<std::path::PathBuf, String> {
    if let Some(dir) = std::env::var_os("LYRSCAPE_DATA_DIR").filter(|dir| !dir.is_empty()) {
        fs::create_dir_all(&dir).map_err(|e| format!("无法创建 LYRSCAPE_DATA_DIR：{e}"))?;
        return Ok(dir.into());
    }
    let exe = exe_directory()?;
    if exe.join("plugins").is_dir() {
        return Ok(exe);
    }
    let data = window
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?;
    fs::create_dir_all(&data).map_err(|e| format!("无法创建应用数据目录：{e}"))?;
    Ok(data)
}

#[tauri::command]
pub fn plugin_install(
    window: WebviewWindow,
    id: String,
    javascript: String,
    css: String,
) -> Result<(), String> {
    super::require_control(&window)?;
    write_plugin(&storage_base(&window)?, &id, &javascript, &css)
}

#[tauri::command]
pub fn plugin_uninstall(window: WebviewWindow, id: String) -> Result<(), String> {
    super::require_control(&window)?;
    remove_plugin(&storage_base(&window)?, &id)
}

/// Saves an exported package to the user's Downloads folder and selects it in Explorer.
#[tauri::command]
pub fn plugin_export_save(
    window: WebviewWindow,
    file_name: String,
    contents: String,
) -> Result<String, String> {
    super::require_control(&window)?;
    if !valid_export_name(&file_name) || contents.len() > 4 * 1024 * 1024 {
        return Err("导出文件名或大小无效".into());
    }
    let downloads = std::env::var_os("USERPROFILE")
        .map(|home| Path::new(&home).join("Downloads"))
        .filter(|path| path.is_dir())
        .map_or_else(exe_directory, Ok)?;
    let stem = file_name.trim_end_matches(".lyrx");
    let mut target = downloads.join(&file_name);
    for n in 2..100 {
        if !target.exists() {
            break;
        }
        target = downloads.join(format!("{stem} ({n}).lyrx"));
    }
    fs::write(&target, contents).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    let _ = std::process::Command::new("explorer")
        .arg(format!("/select,{}", target.display()))
        .spawn();
    Ok(target.display().to_string())
}

#[tauri::command]
pub fn plugins_folder_open(window: WebviewWindow) -> Result<(), String> {
    super::require_control(&window)?;
    let root = ensure_root(&storage_base(&window)?)?;
    #[cfg(windows)]
    std::process::Command::new("explorer")
        .arg(&root)
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(not(windows))]
    let _ = root;
    Ok(())
}

#[tauri::command]
pub fn plugin_source(window: WebviewWindow, id: String) -> Result<PluginSource, String> {
    super::require_control(&window)?;
    read_source(&storage_base(&window)?, &id)
}

#[tauri::command]
pub fn plugin_catalog(window: WebviewWindow) -> Result<Vec<String>, String> {
    super::require_control(&window)?;
    list_catalog(&storage_base(&window)?)
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
    fn install_writes_lists_and_uninstall_removes() {
        let base =
            std::env::temp_dir().join(format!("lyrscape-plugin-install-{}", std::process::id()));
        fs::create_dir_all(&base).unwrap();
        assert_eq!(list_catalog(&base).unwrap(), Vec::<String>::new());
        write_plugin(&base, "local.renderer.wave", "export default {};", ".a{}").unwrap();
        assert_eq!(list_catalog(&base).unwrap(), vec!["local.renderer.wave"]);
        let source = read_source(&base, "local.renderer.wave").unwrap();
        assert_eq!(
            (source.javascript.as_str(), source.css.as_str()),
            ("export default {};", ".a{}")
        );
        write_plugin(&base, "local.renderer.wave", "export default 1;", "").unwrap();
        assert_eq!(read_source(&base, "local.renderer.wave").unwrap().css, "");
        assert!(write_plugin(&base, "../escape", "x", "").is_err());
        remove_plugin(&base, "local.renderer.wave").unwrap();
        assert_eq!(list_catalog(&base).unwrap(), Vec::<String>::new());
        fs::remove_dir_all(base).unwrap();
        assert!(valid_export_name("local.renderer.wave-1.0.0.lyrx"));
        for name in ["../x.lyrx", "a\\b.lyrx", "x.exe", ".lyrx"] {
            assert!(!valid_export_name(name));
        }
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
