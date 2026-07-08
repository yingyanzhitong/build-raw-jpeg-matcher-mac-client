use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    env, fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use walkdir::WalkDir;

use crate::shared::{
    base_name, canonical_path_string, extension_lower, file_name, files_have_same_contents,
    is_macos_metadata_dir, modified_seconds,
};

const JPEG_EXTENSIONS: &[&str] = &["jpg", "jpeg"];
const RAW_EXTENSIONS: &[&str] = &[
    "cr2", "cr3", "nef", "arw", "raf", "orf", "rw2", "dng", "rwl", "pef", "3fr", "iiq",
];
const MIN_RAW_FILE_SIZE_BYTES: u64 = 1024 * 1024;
const RAW_THUMBNAIL_SIZE: &str = "96";

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
    #[serde(default)]
    pub manual: bool,
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
pub(crate) fn collect_jpeg_inputs(inputs: Vec<String>) -> Result<InputCollection, String> {
    collect_jpegs(&inputs).map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn match_raw_files(
    inputs: Vec<String>,
    raw_root: String,
    raw_extensions: Option<Vec<String>>,
    manual_refs: Option<Vec<String>>,
) -> Result<MatchResponse, String> {
    let allowed_extensions =
        normalize_raw_extensions(raw_extensions).map_err(|error| error.to_string())?;
    match_files(
        &inputs,
        &raw_root,
        &allowed_extensions,
        &manual_refs.unwrap_or_default(),
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn export_raw_files(
    results: Vec<MatchResult>,
    export_dir: String,
) -> Result<ExportResponse, String> {
    export_files(&results, &export_dir).map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn raw_thumbnail_path(path: String) -> Result<String, String> {
    generate_raw_thumbnail(Path::new(&path)).map_err(|error| error.to_string())
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
    manual_refs: &[String],
) -> Result<MatchResponse, Box<dyn std::error::Error>> {
    let mut logs = Vec::new();
    let mut input_collection = collect_jpegs(inputs)?;
    logs.extend(input_collection.logs.clone());
    let manual_inputs = manual_inputs_from_refs(manual_refs, &mut logs);
    if !manual_inputs.is_empty() {
        logs.push(format!("文本清单准备完成: {} 条", manual_inputs.len()));
        input_collection.files.extend(manual_inputs);
    }

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
        raw_by_base
            .entry(raw.base_name.clone())
            .or_default()
            .push(raw);
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
        let candidates = find_candidates_for_input(jpeg, &raw_by_base);

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
                    logs.push(format!(
                        "跳过缺少 RAW 选择的条目: {}",
                        result.jpeg.file_name
                    ));
                    continue;
                };

                let source = PathBuf::from(&raw.path);
                let destination = export_path.join(&raw.file_name);
                if destination.exists() {
                    if files_have_same_contents(&source, &destination)? {
                        summary.copied_count += 1;
                        logs.push(format!(
                            "已存在相同 RAW，计入成功: {}",
                            destination.display()
                        ));
                        continue;
                    }
                    summary.collision_count += 1;
                    logs.push(format!("跳过文件名冲突: {}", destination.display()));
                    continue;
                }

                fs::copy(&source, &destination)?;
                summary.copied_count += 1;
                logs.push(format!(
                    "已导出: {} -> {}",
                    raw.file_name,
                    destination.display()
                ));
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

fn generate_raw_thumbnail(path: &Path) -> Result<String, Box<dyn std::error::Error>> {
    if !path.is_file() {
        return Err(format!("RAW 文件不存在: {}", path.display()).into());
    }

    let cache_dir = raw_thumbnail_cache_dir(path);
    fs::create_dir_all(&cache_dir)?;
    let thumbnail_path = cache_dir.join(format!("{}.png", file_name(path)?));
    if thumbnail_path.is_file() {
        return Ok(thumbnail_path.to_string_lossy().to_string());
    }

    let status = Command::new("qlmanage")
        .arg("-t")
        .arg("-s")
        .arg(RAW_THUMBNAIL_SIZE)
        .arg("-o")
        .arg(&cache_dir)
        .arg(path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?;
    if !status.success() {
        return Err(format!("生成 RAW 缩略图失败: {}", path.display()).into());
    }
    if !thumbnail_path.is_file() {
        return Err(format!("未找到 RAW 缩略图输出: {}", thumbnail_path.display()).into());
    }

    Ok(thumbnail_path.to_string_lossy().to_string())
}

fn raw_thumbnail_cache_dir(path: &Path) -> PathBuf {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    canonical_path_string(path).hash(&mut hasher);
    env::temp_dir()
        .join("raw-jpeg-matcher-thumbnails")
        .join(format!("{:016x}", hasher.finish()))
}

#[derive(Debug, Default)]
pub(crate) struct RawScan {
    files: Vec<RawCandidate>,
    logs: Vec<String>,
    small_file_count: usize,
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
                Ok(candidate) => {
                    if candidate.size < MIN_RAW_FILE_SIZE_BYTES {
                        scan.small_file_count += 1;
                        continue;
                    }
                    scan.files.push(candidate);
                }
                Err(error) => scan.logs.push(format!(
                    "跳过无法读取的 RAW 文件 {}: {error}",
                    entry.path().display()
                )),
            }
        }
    }

    scan.files.sort_by(|left, right| left.path.cmp(&right.path));
    if scan.small_file_count > 0 {
        scan.logs.push(format!(
            "跳过 {} 个小于 1 MB 的 RAW 文件",
            scan.small_file_count
        ));
    }
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
        manual: false,
    })
}

fn manual_inputs_from_refs(refs: &[String], logs: &mut Vec<String>) -> Vec<JpegInput> {
    let mut inputs = Vec::new();
    let mut seen = HashSet::new();

    for raw_ref in refs {
        let Some((file_name, base_name)) = normalize_manual_ref(raw_ref) else {
            continue;
        };
        let key = base_name.to_ascii_lowercase();
        if !seen.insert(key) {
            logs.push(format!("跳过重复文本清单项: {file_name}"));
            continue;
        }

        inputs.push(JpegInput {
            path: format!("manual://{file_name}"),
            file_name,
            base_name,
            size: 0,
            modified_time: None,
            manual: true,
        });
    }

    inputs
}

fn normalize_manual_ref(raw_ref: &str) -> Option<(String, String)> {
    let cleaned = raw_ref
        .trim()
        .trim_matches(|character| matches!(character, '"' | '\'' | '`' | ',' | ';'));
    if cleaned.is_empty() {
        return None;
    }

    let file_name = Path::new(cleaned)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(cleaned)
        .to_string();
    let base_name = Path::new(&file_name)
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or(&file_name)
        .to_string();

    Some((file_name, base_name))
}

fn find_candidates_for_input(
    jpeg: &JpegInput,
    raw_by_base: &HashMap<String, Vec<RawCandidate>>,
) -> Vec<RawCandidate> {
    if !jpeg.manual {
        return raw_by_base
            .get(&jpeg.base_name)
            .cloned()
            .unwrap_or_else(Vec::new);
    }

    if let Some(exact_candidates) = raw_by_base.get(&jpeg.base_name) {
        return exact_candidates.clone();
    }

    let suffix = jpeg.base_name.to_ascii_lowercase();
    let mut candidates = raw_by_base
        .iter()
        .filter(|(base_name, _)| base_name.to_ascii_lowercase().ends_with(&suffix))
        .flat_map(|(_, candidates)| candidates.clone())
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| left.path.cmp(&right.path));
    candidates
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, path::Path};
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
        write_raw_file(&raw_dir.join("IMG_1234.CR3"));

        let response = match_files(
            &[jpg_dir.join("IMG_1234.JPG").to_string_lossy().to_string()],
            &temp.path().join("raws").to_string_lossy(),
            &default_raw_extension_set(),
            &[],
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
        write_raw_file(&spotlight.join("IMG_0001.CR3"));
        write_raw_file(&event.join("IMG_0002.CR3"));

        let scan = collect_raws(&raw_root, &default_raw_extension_set());

        assert_eq!(scan.files.len(), 1);
        assert_eq!(scan.files[0].file_name, "IMG_0002.CR3");
    }

    #[test]
    fn raw_scan_filters_files_smaller_than_1_mb() {
        let temp = tempdir().unwrap();
        let raw_root = temp.path().join("raws");
        fs::create_dir_all(&raw_root).unwrap();
        write_sized_file(&raw_root.join("IMG_0001.CR3"), 4 * 1024);
        write_sized_file(&raw_root.join("IMG_0002.CR3"), MIN_RAW_FILE_SIZE_BYTES);

        let scan = collect_raws(&raw_root, &default_raw_extension_set());

        assert_eq!(scan.files.len(), 1);
        assert_eq!(scan.files[0].file_name, "IMG_0002.CR3");
        assert_eq!(scan.small_file_count, 1);
        assert!(scan.logs.iter().any(|log| log.contains("小于 1 MB")));
    }

    #[test]
    fn edited_suffix_does_not_match_original_raw_name() {
        let temp = tempdir().unwrap();
        let jpg_dir = temp.path().join("jpgs");
        let raw_dir = temp.path().join("raws");
        fs::create_dir_all(&jpg_dir).unwrap();
        fs::create_dir_all(&raw_dir).unwrap();
        write_file(&jpg_dir.join("IMG_1234-Edit.JPG"), b"jpg");
        write_raw_file(&raw_dir.join("IMG_1234.CR3"));

        let response = match_files(
            &[jpg_dir
                .join("IMG_1234-Edit.JPG")
                .to_string_lossy()
                .to_string()],
            &raw_dir.to_string_lossy(),
            &default_raw_extension_set(),
            &[],
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
        write_raw_file(&raw_a.join("IMG_7777.CR3"));
        write_raw_file(&raw_b.join("IMG_7777.NEF"));

        let response = match_files(
            &[jpg_dir.join("IMG_7777.JPG").to_string_lossy().to_string()],
            &temp.path().join("raws").to_string_lossy(),
            &default_raw_extension_set(),
            &[],
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
        write_raw_file(&raw_a.join("IMG_8888.CR3"));
        write_raw_file(&raw_b.join("IMG_8888.NEF"));

        let allowed_extensions = normalize_raw_extensions(Some(vec!["CR3".to_string()])).unwrap();
        let response = match_files(
            &[jpg_dir.join("IMG_8888.JPG").to_string_lossy().to_string()],
            &temp.path().join("raws").to_string_lossy(),
            &allowed_extensions,
            &[],
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
    fn manual_suffix_refs_match_raw_base_names() {
        let temp = tempdir().unwrap();
        let raw_dir = temp.path().join("raws");
        fs::create_dir_all(&raw_dir).unwrap();
        write_raw_file(&raw_dir.join("5N6A5022.CR3"));

        let response = match_files(
            &[],
            &raw_dir.to_string_lossy(),
            &default_raw_extension_set(),
            &["5022".to_string()],
        )
        .unwrap();

        assert_eq!(response.summary.input_count, 1);
        assert_eq!(response.summary.matched_count, 1);
        assert!(response.results[0].jpeg.manual);
        assert_eq!(
            response.results[0].selected_raw.as_ref().unwrap().file_name,
            "5N6A5022.CR3"
        );
    }

    #[test]
    fn export_skips_missing_conflicts_and_collisions() {
        let temp = tempdir().unwrap();
        let export_dir = temp.path().join("export");
        fs::create_dir_all(&export_dir).unwrap();
        let raw_source = temp.path().join("IMG_0001.CR3");
        write_raw_file(&raw_source);
        write_file(&export_dir.join("IMG_0001.CR3"), b"existing");

        let jpeg = JpegInput {
            path: temp
                .path()
                .join("IMG_0001.JPG")
                .to_string_lossy()
                .to_string(),
            file_name: "IMG_0001.JPG".to_string(),
            base_name: "IMG_0001".to_string(),
            size: 1,
            modified_time: None,
            manual: false,
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

    #[test]
    fn export_counts_existing_identical_file_as_copied() {
        let temp = tempdir().unwrap();
        let export_dir = temp.path().join("export");
        fs::create_dir_all(&export_dir).unwrap();
        let raw_source = temp.path().join("IMG_0002.CR3");
        write_raw_file(&raw_source);
        fs::copy(&raw_source, export_dir.join("IMG_0002.CR3")).unwrap();

        let jpeg = JpegInput {
            path: temp
                .path()
                .join("IMG_0002.JPG")
                .to_string_lossy()
                .to_string(),
            file_name: "IMG_0002.JPG".to_string(),
            base_name: "IMG_0002".to_string(),
            size: 1,
            modified_time: None,
            manual: false,
        };
        let raw = RawCandidate {
            path: raw_source.to_string_lossy().to_string(),
            file_name: "IMG_0002.CR3".to_string(),
            base_name: "IMG_0002".to_string(),
            extension: "cr3".to_string(),
            size: MIN_RAW_FILE_SIZE_BYTES + 1,
            modified_time: None,
        };
        let results = vec![MatchResult {
            jpeg,
            status: MatchStatus::Matched,
            candidates: vec![raw.clone()],
            selected_raw: Some(raw),
        }];

        let response = export_files(&results, &export_dir.to_string_lossy()).unwrap();

        assert_eq!(response.summary.copied_count, 1);
        assert_eq!(response.summary.collision_count, 0);
        assert!(response
            .logs
            .iter()
            .any(|log| log.contains("已存在相同 RAW")));
    }

    fn write_file(path: &Path, bytes: &[u8]) {
        let mut file = fs::File::create(path).unwrap();
        file.write_all(bytes).unwrap();
    }

    fn write_raw_file(path: &Path) {
        write_sized_file(path, MIN_RAW_FILE_SIZE_BYTES + 1);
    }

    fn write_sized_file(path: &Path, size: u64) {
        let file = fs::File::create(path).unwrap();
        file.set_len(size).unwrap();
    }
}
