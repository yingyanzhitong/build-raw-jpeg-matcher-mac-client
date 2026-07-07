use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};
use walkdir::WalkDir;

const JPEG_EXTENSIONS: &[&str] = &["jpg", "jpeg"];
const RAW_EXTENSIONS: &[&str] = &[
    "cr2", "cr3", "nef", "arw", "raf", "orf", "rw2", "dng", "rwl", "pef", "3fr", "iiq",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MatchStatus {
    Matched,
    Missing,
    Conflict,
    Confirmed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JpegInput {
    pub path: String,
    pub file_name: String,
    pub base_name: String,
    pub size: u64,
    pub modified_time: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RawCandidate {
    pub path: String,
    pub file_name: String,
    pub base_name: String,
    pub extension: String,
    pub size: u64,
    pub modified_time: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MatchResult {
    pub jpeg: JpegInput,
    pub status: MatchStatus,
    pub candidates: Vec<RawCandidate>,
    pub selected_raw: Option<RawCandidate>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MatchSummary {
    pub input_count: usize,
    pub matched_count: usize,
    pub missing_count: usize,
    pub conflict_count: usize,
    pub confirmed_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InputCollection {
    pub files: Vec<JpegInput>,
    pub logs: Vec<String>,
    pub skipped_count: usize,
    pub duplicate_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MatchResponse {
    pub jpeg_inputs: Vec<JpegInput>,
    pub results: Vec<MatchResult>,
    pub logs: Vec<String>,
    pub summary: MatchSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportSummary {
    pub copied_count: usize,
    pub skipped_missing_count: usize,
    pub skipped_conflict_count: usize,
    pub collision_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportResponse {
    pub logs: Vec<String>,
    pub summary: ExportSummary,
}

#[tauri::command]
fn collect_jpeg_inputs(inputs: Vec<String>) -> Result<InputCollection, String> {
    collect_jpegs(&inputs).map_err(|error| error.to_string())
}

#[tauri::command]
fn match_raw_files(
    inputs: Vec<String>,
    raw_root: String,
    raw_extensions: Option<Vec<String>>,
) -> Result<MatchResponse, String> {
    let allowed_extensions =
        normalize_raw_extensions(raw_extensions).map_err(|error| error.to_string())?;
    match_files(&inputs, &raw_root, &allowed_extensions).map_err(|error| error.to_string())
}

#[tauri::command]
fn export_raw_files(
    results: Vec<MatchResult>,
    export_dir: String,
) -> Result<ExportResponse, String> {
    export_files(&results, &export_dir).map_err(|error| error.to_string())
}

#[tauri::command]
fn read_jpeg_data_url(path: String) -> Result<String, String> {
    let file_path = PathBuf::from(path);
    if !is_jpeg_path(&file_path) {
        return Err("只能预览 JPEG 文件".to_string());
    }

    let bytes = fs::read(&file_path).map_err(|error| format!("读取 JPEG 失败: {error}"))?;
    let encoded = general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:image/jpeg;base64,{encoded}"))
}

fn collect_jpegs(inputs: &[String]) -> Result<InputCollection, Box<dyn std::error::Error>> {
    let mut files = Vec::new();
    let mut logs = Vec::new();
    let mut seen = HashSet::new();
    let mut skipped_count = 0;
    let mut duplicate_count = 0;

    for input in inputs {
        let input_path = PathBuf::from(input);
        if !input_path.exists() {
            skipped_count += 1;
            logs.push(format!("跳过不存在的路径: {}", input_path.display()));
            continue;
        }

        if input_path.is_dir() {
            for entry in WalkDir::new(&input_path).into_iter() {
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(error) => {
                        skipped_count += 1;
                        logs.push(format!("跳过无法访问的路径: {error}"));
                        continue;
                    }
                };

                if !entry.file_type().is_file() {
                    continue;
                }

                let path = entry.path();
                if is_jpeg_path(path) {
                    if add_jpeg(path, &mut files, &mut seen)? {
                        continue;
                    }
                    duplicate_count += 1;
                } else {
                    skipped_count += 1;
                }
            }
        } else if input_path.is_file() && is_jpeg_path(&input_path) {
            if !add_jpeg(&input_path, &mut files, &mut seen)? {
                duplicate_count += 1;
            }
        } else {
            skipped_count += 1;
            logs.push(format!("跳过不支持的输入: {}", input_path.display()));
        }
    }

    files.sort_by(|left, right| left.path.cmp(&right.path));

    if duplicate_count > 0 {
        logs.push(format!("已跳过 {duplicate_count} 个重复 JPEG 输入"));
    }
    if skipped_count > 0 {
        logs.push(format!("已跳过 {skipped_count} 个不支持或无法访问的输入"));
    }
    logs.push(format!("JPEG 输入准备完成: {} 个文件", files.len()));

    Ok(InputCollection {
        files,
        logs,
        skipped_count,
        duplicate_count,
    })
}

fn match_files(
    inputs: &[String],
    raw_root: &str,
    allowed_raw_extensions: &HashSet<String>,
) -> Result<MatchResponse, Box<dyn std::error::Error>> {
    let mut logs = Vec::new();
    let input_collection = collect_jpegs(inputs)?;
    logs.extend(input_collection.logs.clone());

    let raw_root_path = PathBuf::from(raw_root);
    if !raw_root_path.is_dir() {
        return Err(format!("RAW 源目录不存在或不是目录: {}", raw_root_path.display()).into());
    }

    logs.push(format!("开始扫描 RAW 源目录: {}", raw_root_path.display()));
    logs.push(format!(
        "RAW 格式过滤: {}",
        sorted_extensions_for_log(allowed_raw_extensions).join(", ")
    ));
    let raw_scan = collect_raws(&raw_root_path, allowed_raw_extensions);
    logs.extend(raw_scan.logs);
    let raw_candidates = raw_scan.files;
    logs.push(format!("RAW 扫描完成: {} 个候选文件", raw_candidates.len()));

    let mut raw_by_base: HashMap<String, Vec<RawCandidate>> = HashMap::new();
    for raw in raw_candidates {
        raw_by_base.entry(raw.base_name.clone()).or_default().push(raw);
    }

    for candidates in raw_by_base.values_mut() {
        candidates.sort_by(|left, right| left.path.cmp(&right.path));
    }

    let mut summary = MatchSummary {
        input_count: input_collection.files.len(),
        ..MatchSummary::default()
    };
    let mut results = Vec::with_capacity(input_collection.files.len());

    for jpeg in &input_collection.files {
        let candidates = raw_by_base
            .get(&jpeg.base_name)
            .cloned()
            .unwrap_or_else(Vec::new);

        let (status, selected_raw) = match candidates.len() {
            0 => {
                summary.missing_count += 1;
                logs.push(format!("未找到 RAW: {}", jpeg.file_name));
                (MatchStatus::Missing, None)
            }
            1 => {
                summary.matched_count += 1;
                let selected = candidates.first().cloned();
                if let Some(raw) = &selected {
                    logs.push(format!("已匹配: {} -> {}", jpeg.file_name, raw.file_name));
                }
                (MatchStatus::Matched, selected)
            }
            _ => {
                summary.conflict_count += 1;
                logs.push(format!(
                    "存在冲突: {} 对应 {} 个 RAW 候选",
                    jpeg.file_name,
                    candidates.len()
                ));
                (MatchStatus::Conflict, None)
            }
        };

        results.push(MatchResult {
            jpeg: jpeg.clone(),
            status,
            candidates,
            selected_raw,
        });
    }

    logs.push(format!(
        "查找完成: 输入 {}，已匹配 {}，未找到 {}，冲突 {}",
        summary.input_count, summary.matched_count, summary.missing_count, summary.conflict_count
    ));

    Ok(MatchResponse {
        jpeg_inputs: input_collection.files,
        results,
        logs,
        summary,
    })
}

fn export_files(
    results: &[MatchResult],
    export_dir: &str,
) -> Result<ExportResponse, Box<dyn std::error::Error>> {
    let export_path = PathBuf::from(export_dir);
    if !export_path.is_dir() {
        return Err(format!("导出目标目录不存在或不是目录: {}", export_path.display()).into());
    }

    let mut logs = Vec::new();
    let mut summary = ExportSummary::default();

    for result in results {
        match result.status {
            MatchStatus::Missing => {
                summary.skipped_missing_count += 1;
                logs.push(format!("跳过未找到 RAW 的 JPEG: {}", result.jpeg.file_name));
            }
            MatchStatus::Conflict => {
                summary.skipped_conflict_count += 1;
                logs.push(format!("跳过未解决冲突: {}", result.jpeg.file_name));
            }
            MatchStatus::Matched | MatchStatus::Confirmed => {
                let Some(raw) = &result.selected_raw else {
                    summary.skipped_conflict_count += 1;
                    logs.push(format!("跳过缺少 RAW 选择的条目: {}", result.jpeg.file_name));
                    continue;
                };

                let source = PathBuf::from(&raw.path);
                let destination = export_path.join(&raw.file_name);
                if destination.exists() {
                    summary.collision_count += 1;
                    logs.push(format!("跳过文件名冲突: {}", destination.display()));
                    continue;
                }

                fs::copy(&source, &destination)?;
                summary.copied_count += 1;
                logs.push(format!("已导出: {} -> {}", raw.file_name, destination.display()));
            }
        }
    }

    logs.push(format!(
        "导出完成: 已复制 {}，跳过未找到 {}，跳过冲突 {}，文件名冲突 {}",
        summary.copied_count,
        summary.skipped_missing_count,
        summary.skipped_conflict_count,
        summary.collision_count
    ));

    Ok(ExportResponse { logs, summary })
}

#[derive(Debug, Default)]
struct RawScan {
    files: Vec<RawCandidate>,
    logs: Vec<String>,
}

fn collect_raws(raw_root: &Path, allowed_raw_extensions: &HashSet<String>) -> RawScan {
    let mut scan = RawScan::default();

    for entry in WalkDir::new(raw_root)
        .into_iter()
        .filter_entry(|entry| !is_macos_metadata_dir(entry.path()))
    {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                scan.logs.push(format!("跳过无法访问的 RAW 路径: {error}"));
                continue;
            }
        };

        if entry.file_type().is_file() && is_raw_path(entry.path(), allowed_raw_extensions) {
            match raw_candidate_from_path(entry.path()) {
                Ok(candidate) => scan.files.push(candidate),
                Err(error) => scan.logs.push(format!(
                    "跳过无法读取的 RAW 文件 {}: {error}",
                    entry.path().display()
                )),
            }
        }
    }

    scan.files.sort_by(|left, right| left.path.cmp(&right.path));
    scan
}

fn normalize_raw_extensions(
    raw_extensions: Option<Vec<String>>,
) -> Result<HashSet<String>, Box<dyn std::error::Error>> {
    let requested = raw_extensions.unwrap_or_else(|| {
        RAW_EXTENSIONS
            .iter()
            .map(|extension| extension.to_string())
            .collect()
    });

    let mut normalized = HashSet::new();
    for extension in requested {
        let extension = extension
            .trim()
            .trim_start_matches('.')
            .to_ascii_lowercase();
        if RAW_EXTENSIONS.contains(&extension.as_str()) {
            normalized.insert(extension);
        }
    }

    if normalized.is_empty() {
        return Err("至少选择一种支持的 RAW 格式".into());
    }

    Ok(normalized)
}

#[cfg(test)]
fn default_raw_extension_set() -> HashSet<String> {
    RAW_EXTENSIONS
        .iter()
        .map(|extension| extension.to_string())
        .collect()
}

fn sorted_extensions_for_log(extensions: &HashSet<String>) -> Vec<String> {
    let mut extensions = extensions
        .iter()
        .map(|extension| extension.to_ascii_uppercase())
        .collect::<Vec<_>>();
    extensions.sort();
    extensions
}

fn add_jpeg(
    path: &Path,
    files: &mut Vec<JpegInput>,
    seen: &mut HashSet<String>,
) -> Result<bool, Box<dyn std::error::Error>> {
    let key = canonical_path_string(path);
    if !seen.insert(key) {
        return Ok(false);
    }

    files.push(jpeg_input_from_path(path)?);
    Ok(true)
}

fn jpeg_input_from_path(path: &Path) -> Result<JpegInput, Box<dyn std::error::Error>> {
    let metadata = fs::metadata(path)?;
    Ok(JpegInput {
        path: canonical_path_string(path),
        file_name: file_name(path)?,
        base_name: base_name(path)?,
        size: metadata.len(),
        modified_time: modified_seconds(&metadata),
    })
}

fn raw_candidate_from_path(path: &Path) -> Result<RawCandidate, Box<dyn std::error::Error>> {
    let metadata = fs::metadata(path)?;
    Ok(RawCandidate {
        path: canonical_path_string(path),
        file_name: file_name(path)?,
        base_name: base_name(path)?,
        extension: extension_lower(path).unwrap_or_default(),
        size: metadata.len(),
        modified_time: modified_seconds(&metadata),
    })
}

fn is_jpeg_path(path: &Path) -> bool {
    extension_lower(path)
        .map(|extension| JPEG_EXTENSIONS.contains(&extension.as_str()))
        .unwrap_or(false)
}

fn is_raw_path(path: &Path, allowed_raw_extensions: &HashSet<String>) -> bool {
    extension_lower(path)
        .map(|extension| allowed_raw_extensions.contains(&extension))
        .unwrap_or(false)
}

fn is_macos_metadata_dir(path: &Path) -> bool {
    if !path.is_dir() {
        return false;
    }

    matches!(
        path.file_name().and_then(|name| name.to_str()),
        Some(".Spotlight-V100" | ".Trashes" | ".fseventsd" | ".TemporaryItems")
    )
}

fn extension_lower(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
}

fn file_name(path: &Path) -> Result<String, Box<dyn std::error::Error>> {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .ok_or_else(|| format!("无法读取文件名: {}", path.display()).into())
}

fn base_name(path: &Path) -> Result<String, Box<dyn std::error::Error>> {
    path.file_stem()
        .map(|name| name.to_string_lossy().to_string())
        .ok_or_else(|| format!("无法读取主文件名: {}", path.display()).into())
}

fn canonical_path_string(path: &Path) -> String {
    fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string()
}

fn modified_seconds(metadata: &fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            collect_jpeg_inputs,
            match_raw_files,
            export_raw_files,
            read_jpeg_data_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    #[test]
    fn detects_extensions_case_insensitively() {
        let allowed_extensions = default_raw_extension_set();
        assert!(is_jpeg_path(Path::new("IMG_0001.JPG")));
        assert!(is_jpeg_path(Path::new("IMG_0001.JpEg")));
        assert!(is_raw_path(Path::new("IMG_0001.CR3"), &allowed_extensions));
        assert!(is_raw_path(Path::new("IMG_0001.ArW"), &allowed_extensions));
        assert!(!is_raw_path(Path::new("IMG_0001.txt"), &allowed_extensions));
    }

    #[test]
    fn discovers_nested_jpeg_inputs_and_deduplicates() {
        let temp = tempdir().unwrap();
        let nested = temp.path().join("client/round1");
        fs::create_dir_all(&nested).unwrap();
        write_file(&nested.join("IMG_1001.JPG"), b"jpg");
        write_file(&nested.join("notes.txt"), b"notes");

        let inputs = vec![
            temp.path().join("client").to_string_lossy().to_string(),
            nested.join("IMG_1001.JPG").to_string_lossy().to_string(),
        ];

        let collection = collect_jpegs(&inputs).unwrap();
        assert_eq!(collection.files.len(), 1);
        assert_eq!(collection.files[0].base_name, "IMG_1001");
        assert_eq!(collection.duplicate_count, 1);
        assert_eq!(collection.skipped_count, 1);
    }

    #[test]
    fn matches_nested_raws_by_exact_base_name() {
        let temp = tempdir().unwrap();
        let jpg_dir = temp.path().join("jpgs");
        let raw_dir = temp.path().join("raws/event");
        fs::create_dir_all(&jpg_dir).unwrap();
        fs::create_dir_all(&raw_dir).unwrap();
        write_file(&jpg_dir.join("IMG_1234.JPG"), b"jpg");
        write_file(&raw_dir.join("IMG_1234.CR3"), b"raw");

        let response = match_files(
            &[jpg_dir.join("IMG_1234.JPG").to_string_lossy().to_string()],
            &temp.path().join("raws").to_string_lossy(),
            &default_raw_extension_set(),
        )
        .unwrap();

        assert_eq!(response.summary.matched_count, 1);
        assert_eq!(response.results[0].status, MatchStatus::Matched);
        assert_eq!(
            response.results[0].selected_raw.as_ref().unwrap().file_name,
            "IMG_1234.CR3"
        );
    }

    #[test]
    fn raw_scan_skips_macos_metadata_directories() {
        let temp = tempdir().unwrap();
        let raw_root = temp.path().join("raws");
        let spotlight = raw_root.join(".Spotlight-V100");
        let event = raw_root.join("event");
        fs::create_dir_all(&spotlight).unwrap();
        fs::create_dir_all(&event).unwrap();
        write_file(&spotlight.join("IMG_0001.CR3"), b"system");
        write_file(&event.join("IMG_0002.CR3"), b"raw");

        let scan = collect_raws(&raw_root, &default_raw_extension_set());

        assert_eq!(scan.files.len(), 1);
        assert_eq!(scan.files[0].file_name, "IMG_0002.CR3");
    }

    #[test]
    fn edited_suffix_does_not_match_original_raw_name() {
        let temp = tempdir().unwrap();
        let jpg_dir = temp.path().join("jpgs");
        let raw_dir = temp.path().join("raws");
        fs::create_dir_all(&jpg_dir).unwrap();
        fs::create_dir_all(&raw_dir).unwrap();
        write_file(&jpg_dir.join("IMG_1234-Edit.JPG"), b"jpg");
        write_file(&raw_dir.join("IMG_1234.CR3"), b"raw");

        let response = match_files(
            &[jpg_dir.join("IMG_1234-Edit.JPG").to_string_lossy().to_string()],
            &raw_dir.to_string_lossy(),
            &default_raw_extension_set(),
        )
        .unwrap();

        assert_eq!(response.summary.missing_count, 1);
        assert_eq!(response.results[0].status, MatchStatus::Missing);
    }

    #[test]
    fn multiple_raw_candidates_create_conflict() {
        let temp = tempdir().unwrap();
        let jpg_dir = temp.path().join("jpgs");
        let raw_a = temp.path().join("raws/a");
        let raw_b = temp.path().join("raws/b");
        fs::create_dir_all(&jpg_dir).unwrap();
        fs::create_dir_all(&raw_a).unwrap();
        fs::create_dir_all(&raw_b).unwrap();
        write_file(&jpg_dir.join("IMG_7777.JPG"), b"jpg");
        write_file(&raw_a.join("IMG_7777.CR3"), b"raw-a");
        write_file(&raw_b.join("IMG_7777.NEF"), b"raw-b");

        let response = match_files(
            &[jpg_dir.join("IMG_7777.JPG").to_string_lossy().to_string()],
            &temp.path().join("raws").to_string_lossy(),
            &default_raw_extension_set(),
        )
        .unwrap();

        assert_eq!(response.summary.conflict_count, 1);
        assert_eq!(response.results[0].status, MatchStatus::Conflict);
        assert_eq!(response.results[0].candidates.len(), 2);
        assert!(response.results[0].selected_raw.is_none());
    }

    #[test]
    fn selected_raw_extensions_filter_candidates() {
        let temp = tempdir().unwrap();
        let jpg_dir = temp.path().join("jpgs");
        let raw_a = temp.path().join("raws/a");
        let raw_b = temp.path().join("raws/b");
        fs::create_dir_all(&jpg_dir).unwrap();
        fs::create_dir_all(&raw_a).unwrap();
        fs::create_dir_all(&raw_b).unwrap();
        write_file(&jpg_dir.join("IMG_8888.JPG"), b"jpg");
        write_file(&raw_a.join("IMG_8888.CR3"), b"raw-a");
        write_file(&raw_b.join("IMG_8888.NEF"), b"raw-b");

        let allowed_extensions = normalize_raw_extensions(Some(vec!["CR3".to_string()])).unwrap();
        let response = match_files(
            &[jpg_dir.join("IMG_8888.JPG").to_string_lossy().to_string()],
            &temp.path().join("raws").to_string_lossy(),
            &allowed_extensions,
        )
        .unwrap();

        assert_eq!(response.summary.matched_count, 1);
        assert_eq!(response.summary.conflict_count, 0);
        assert_eq!(response.results[0].status, MatchStatus::Matched);
        assert_eq!(
            response.results[0].selected_raw.as_ref().unwrap().file_name,
            "IMG_8888.CR3"
        );
    }

    #[test]
    fn export_skips_missing_conflicts_and_collisions() {
        let temp = tempdir().unwrap();
        let export_dir = temp.path().join("export");
        fs::create_dir_all(&export_dir).unwrap();
        let raw_source = temp.path().join("IMG_0001.CR3");
        write_file(&raw_source, b"raw");
        write_file(&export_dir.join("IMG_0001.CR3"), b"existing");

        let jpeg = JpegInput {
            path: temp.path().join("IMG_0001.JPG").to_string_lossy().to_string(),
            file_name: "IMG_0001.JPG".to_string(),
            base_name: "IMG_0001".to_string(),
            size: 1,
            modified_time: None,
        };
        let raw = RawCandidate {
            path: raw_source.to_string_lossy().to_string(),
            file_name: "IMG_0001.CR3".to_string(),
            base_name: "IMG_0001".to_string(),
            extension: "cr3".to_string(),
            size: 1,
            modified_time: None,
        };
        let results = vec![
            MatchResult {
                jpeg: jpeg.clone(),
                status: MatchStatus::Matched,
                candidates: vec![raw.clone()],
                selected_raw: Some(raw),
            },
            MatchResult {
                jpeg: jpeg.clone(),
                status: MatchStatus::Missing,
                candidates: vec![],
                selected_raw: None,
            },
            MatchResult {
                jpeg,
                status: MatchStatus::Conflict,
                candidates: vec![],
                selected_raw: None,
            },
        ];

        let response = export_files(&results, &export_dir.to_string_lossy()).unwrap();
        assert_eq!(response.summary.copied_count, 0);
        assert_eq!(response.summary.collision_count, 1);
        assert_eq!(response.summary.skipped_missing_count, 1);
        assert_eq!(response.summary.skipped_conflict_count, 1);
    }

    fn write_file(path: &Path, bytes: &[u8]) {
        let mut file = fs::File::create(path).unwrap();
        file.write_all(bytes).unwrap();
    }
}
