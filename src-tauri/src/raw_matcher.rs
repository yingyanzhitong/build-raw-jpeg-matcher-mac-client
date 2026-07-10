use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    env,
    fs::{self, OpenOptions},
    hash::{Hash, Hasher},
    io,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use walkdir::WalkDir;

use crate::shared::{
    base_name, canonical_path_string, extension_lower, file_name, files_have_same_contents,
    is_macos_metadata_dir, modified_seconds,
};

pub(crate) const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png"];
pub(crate) const RAW_EXTENSIONS: &[&str] = &[
    "cr2", "cr3", "nef", "arw", "raf", "orf", "rw2", "dng", "rwl", "pef", "3fr", "iiq",
];
const MIN_RAW_FILE_SIZE_BYTES: u64 = 1024 * 1024;
const FILE_THUMBNAIL_SIZE: &str = "256";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MatchDirection {
    ImageToRaw,
    RawToImage,
}

impl MatchDirection {
    fn label(self) -> &'static str {
        match self {
            Self::ImageToRaw => "图片 → RAW",
            Self::RawToImage => "RAW → 图片",
        }
    }

    fn input_role(self) -> FileRole {
        match self {
            Self::ImageToRaw => FileRole::Image,
            Self::RawToImage => FileRole::Raw,
        }
    }

    fn candidate_role(self) -> FileRole {
        match self {
            Self::ImageToRaw => FileRole::Raw,
            Self::RawToImage => FileRole::Image,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FileRole {
    Image,
    Raw,
}

impl FileRole {
    fn label(self) -> &'static str {
        match self {
            Self::Image => "图片",
            Self::Raw => "RAW",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MatcherCapabilities {
    pub image_extensions: Vec<String>,
    pub raw_extensions: Vec<String>,
}

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
pub struct MatchFile {
    pub path: String,
    pub file_name: String,
    pub base_name: String,
    pub extension: String,
    pub size: u64,
    pub modified_time: Option<u64>,
    #[serde(default)]
    pub manual: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MatchResult {
    pub input: MatchFile,
    pub status: MatchStatus,
    pub candidates: Vec<MatchFile>,
    pub selected_candidate: Option<MatchFile>,
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
    pub files: Vec<MatchFile>,
    pub logs: Vec<String>,
    pub skipped_count: usize,
    pub duplicate_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MatchResponse {
    pub inputs: Vec<MatchFile>,
    pub results: Vec<MatchResult>,
    pub logs: Vec<String>,
    pub summary: MatchSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportSummary {
    pub copied_count: usize,
    pub already_present_count: usize,
    pub skipped_missing_count: usize,
    pub skipped_conflict_count: usize,
    pub collision_count: usize,
    pub source_error_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportResponse {
    pub logs: Vec<String>,
    pub summary: ExportSummary,
}

#[tauri::command]
pub(crate) fn matcher_capabilities() -> MatcherCapabilities {
    MatcherCapabilities {
        image_extensions: IMAGE_EXTENSIONS
            .iter()
            .map(|extension| extension.to_string())
            .collect(),
        raw_extensions: RAW_EXTENSIONS
            .iter()
            .map(|extension| extension.to_string())
            .collect(),
    }
}

#[tauri::command]
pub(crate) fn collect_match_inputs(
    direction: MatchDirection,
    paths: Vec<String>,
    selected_raw_formats: Option<Vec<String>>,
) -> Result<InputCollection, String> {
    let allowed_raw_extensions = match direction {
        MatchDirection::ImageToRaw => default_raw_extension_set(),
        MatchDirection::RawToImage => {
            normalize_raw_extensions(selected_raw_formats).map_err(|error| error.to_string())?
        }
    };
    Ok(collect_inputs(direction, &paths, &allowed_raw_extensions))
}

#[tauri::command]
pub(crate) fn match_counterpart_files(
    direction: MatchDirection,
    inputs: Vec<MatchFile>,
    manual_refs: Option<Vec<String>>,
    search_root: String,
    selected_raw_formats: Option<Vec<String>>,
) -> Result<MatchResponse, String> {
    let allowed_raw_extensions =
        normalize_raw_extensions(selected_raw_formats).map_err(|error| error.to_string())?;
    let mut input_paths = Vec::new();
    let mut combined_manual_refs = manual_refs.unwrap_or_default();

    for input in inputs {
        if input.manual {
            combined_manual_refs.push(input.file_name);
        } else {
            input_paths.push(input.path);
        }
    }

    match_files(
        direction,
        &input_paths,
        &search_root,
        &allowed_raw_extensions,
        &combined_manual_refs,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn export_matched_files(
    direction: MatchDirection,
    results: Vec<MatchResult>,
    export_dir: String,
    search_root: String,
    selected_raw_formats: Option<Vec<String>>,
) -> Result<ExportResponse, String> {
    let allowed_raw_extensions =
        normalize_raw_extensions(selected_raw_formats).map_err(|error| error.to_string())?;
    export_files(
        direction,
        &results,
        &export_dir,
        &search_root,
        &allowed_raw_extensions,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn file_thumbnail_path(path: String) -> Result<String, String> {
    generate_file_thumbnail(Path::new(&path)).map_err(|error| error.to_string())
}

#[derive(Debug, Default)]
struct CollectionAccumulator {
    files: Vec<MatchFile>,
    logs: Vec<String>,
    seen: HashSet<String>,
    skipped_count: usize,
    duplicate_count: usize,
    small_raw_count: usize,
}

impl CollectionAccumulator {
    fn add_file(&mut self, path: &Path, role: FileRole, allowed_raw_extensions: &HashSet<String>) {
        if !is_supported_path(path, role, allowed_raw_extensions) {
            self.skipped_count += 1;
            return;
        }

        let file = match match_file_from_path(path) {
            Ok(file) => file,
            Err(error) => {
                self.skipped_count += 1;
                self.logs.push(format!(
                    "跳过无法读取的 {} 文件 {}: {error}",
                    role.label(),
                    path.display()
                ));
                return;
            }
        };

        if role == FileRole::Raw && file.size < MIN_RAW_FILE_SIZE_BYTES {
            self.skipped_count += 1;
            self.small_raw_count += 1;
            return;
        }

        if !self.seen.insert(file.path.clone()) {
            self.duplicate_count += 1;
            return;
        }

        self.files.push(file);
    }
}

fn collect_inputs(
    direction: MatchDirection,
    paths: &[String],
    allowed_raw_extensions: &HashSet<String>,
) -> InputCollection {
    let role = direction.input_role();
    let mut collection = CollectionAccumulator::default();
    if role == FileRole::Raw {
        collection.logs.push(format!(
            "RAW 格式过滤: {}",
            sorted_extensions_for_log(allowed_raw_extensions).join(", ")
        ));
    }

    for requested_path in paths {
        let path = PathBuf::from(requested_path);
        if !path.exists() {
            collection.skipped_count += 1;
            collection
                .logs
                .push(format!("跳过不存在的路径: {}", path.display()));
            continue;
        }

        if path.is_dir() {
            scan_directory_into(&path, role, allowed_raw_extensions, &mut collection);
        } else if path.is_file() {
            collection.add_file(&path, role, allowed_raw_extensions);
        } else {
            collection.skipped_count += 1;
            collection
                .logs
                .push(format!("跳过不支持的输入: {}", path.display()));
        }
    }

    collection
        .files
        .sort_by(|left, right| left.path.cmp(&right.path));
    append_collection_summary_logs(&mut collection, &format!("{} 输入", role.label()));

    InputCollection {
        files: collection.files,
        logs: collection.logs,
        skipped_count: collection.skipped_count,
        duplicate_count: collection.duplicate_count,
    }
}

fn scan_directory_into(
    root: &Path,
    role: FileRole,
    allowed_raw_extensions: &HashSet<String>,
    collection: &mut CollectionAccumulator,
) {
    for entry in WalkDir::new(root)
        .into_iter()
        .filter_entry(|entry| !is_macos_metadata_dir(entry.path()))
    {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                collection.skipped_count += 1;
                collection.logs.push(format!("跳过无法访问的路径: {error}"));
                continue;
            }
        };

        if entry.file_type().is_file() {
            collection.add_file(entry.path(), role, allowed_raw_extensions);
        }
    }
}

fn append_collection_summary_logs(collection: &mut CollectionAccumulator, label: &str) {
    if collection.small_raw_count > 0 {
        collection.logs.push(format!(
            "跳过 {} 个小于 1 MB 的 RAW 文件",
            collection.small_raw_count
        ));
    }
    if collection.duplicate_count > 0 {
        collection.logs.push(format!(
            "已跳过 {} 个重复{}",
            collection.duplicate_count, label
        ));
    }
    if collection.skipped_count > 0 {
        collection.logs.push(format!(
            "已跳过 {} 个不支持、过小或无法访问的{}",
            collection.skipped_count, label
        ));
    }
    collection.logs.push(format!(
        "{label}准备完成: {} 个文件",
        collection.files.len()
    ));
}

fn match_files(
    direction: MatchDirection,
    input_paths: &[String],
    search_root: &str,
    allowed_raw_extensions: &HashSet<String>,
    manual_refs: &[String],
) -> Result<MatchResponse, Box<dyn std::error::Error>> {
    let mut logs = vec![format!("开始执行 {} 配对", direction.label())];
    let mut input_collection = collect_inputs(direction, input_paths, allowed_raw_extensions);
    logs.append(&mut input_collection.logs);

    if !manual_refs.is_empty() {
        let manual_inputs =
            manual_inputs_from_refs(direction, manual_refs, allowed_raw_extensions, &mut logs);
        if !manual_inputs.is_empty() {
            logs.push(format!(
                "{}文本清单准备完成: {} 条",
                direction.input_role().label(),
                manual_inputs.len()
            ));
            input_collection.files.extend(manual_inputs);
        }
    }

    if input_collection.files.is_empty() {
        return Err(format!("没有可用于匹配的{}输入", direction.input_role().label()).into());
    }

    let search_root_path = PathBuf::from(search_root);
    if !search_root_path.is_dir() {
        return Err(format!(
            "{}查找目录不存在或不是目录: {}",
            direction.candidate_role().label(),
            search_root_path.display()
        )
        .into());
    }

    logs.push(format!(
        "开始扫描 {} 查找目录: {}",
        direction.candidate_role().label(),
        search_root_path.display()
    ));
    if direction.candidate_role() == FileRole::Raw {
        logs.push(format!(
            "RAW 格式过滤: {}",
            sorted_extensions_for_log(allowed_raw_extensions).join(", ")
        ));
    }

    let mut candidate_scan = collect_candidates(
        &search_root_path,
        direction.candidate_role(),
        allowed_raw_extensions,
    );
    logs.append(&mut candidate_scan.logs);
    let candidates = candidate_scan.files;
    logs.push(format!(
        "{}候选扫描完成: {} 个文件",
        direction.candidate_role().label(),
        candidates.len()
    ));

    let candidates_by_base = index_candidates(candidates);

    let mut summary = MatchSummary {
        input_count: input_collection.files.len(),
        ..MatchSummary::default()
    };
    let mut results = Vec::with_capacity(input_collection.files.len());

    for input in &input_collection.files {
        let candidates = find_candidates_for_input(input, &candidates_by_base);
        let (status, selected_candidate) = match candidates.len() {
            0 => {
                summary.missing_count += 1;
                logs.push(format!(
                    "未找到对应 {}: {}",
                    direction.candidate_role().label(),
                    input.file_name
                ));
                (MatchStatus::Missing, None)
            }
            1 => {
                summary.matched_count += 1;
                let selected = candidates.first().cloned();
                if let Some(candidate) = &selected {
                    logs.push(format!(
                        "已匹配: {} -> {}",
                        input.file_name, candidate.file_name
                    ));
                }
                (MatchStatus::Matched, selected)
            }
            _ => {
                summary.conflict_count += 1;
                logs.push(format!(
                    "存在冲突: {} 对应 {} 个{}候选",
                    input.file_name,
                    candidates.len(),
                    direction.candidate_role().label()
                ));
                (MatchStatus::Conflict, None)
            }
        };

        results.push(MatchResult {
            input: input.clone(),
            status,
            candidates,
            selected_candidate,
        });
    }

    logs.push(format!(
        "{} 查找完成: 输入 {}，已匹配 {}，未找到 {}，冲突 {}，已确认 {}",
        direction.label(),
        summary.input_count,
        summary.matched_count,
        summary.missing_count,
        summary.conflict_count,
        summary.confirmed_count
    ));

    Ok(MatchResponse {
        inputs: input_collection.files,
        results,
        logs,
        summary,
    })
}

#[derive(Debug, Default)]
struct FileScan {
    files: Vec<MatchFile>,
    logs: Vec<String>,
}

fn collect_candidates(
    root: &Path,
    role: FileRole,
    allowed_raw_extensions: &HashSet<String>,
) -> FileScan {
    let mut collection = CollectionAccumulator::default();
    scan_directory_into(root, role, allowed_raw_extensions, &mut collection);
    collection
        .files
        .sort_by(|left, right| left.path.cmp(&right.path));

    if collection.small_raw_count > 0 {
        collection.logs.push(format!(
            "候选扫描跳过 {} 个小于 1 MB 的 RAW 文件",
            collection.small_raw_count
        ));
    }
    if collection.duplicate_count > 0 {
        collection.logs.push(format!(
            "候选扫描跳过 {} 个重复文件",
            collection.duplicate_count
        ));
    }
    if collection.skipped_count > 0 {
        collection.logs.push(format!(
            "候选扫描跳过 {} 个不支持、过小或无法访问的文件",
            collection.skipped_count
        ));
    }

    FileScan {
        files: collection.files,
        logs: collection.logs,
    }
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

fn match_file_from_path(path: &Path) -> Result<MatchFile, Box<dyn std::error::Error>> {
    let metadata = fs::metadata(path)?;
    Ok(MatchFile {
        path: canonical_path_string(path),
        file_name: file_name(path)?,
        base_name: base_name(path)?,
        extension: extension_lower(path).unwrap_or_default(),
        size: metadata.len(),
        modified_time: modified_seconds(&metadata),
        manual: false,
    })
}

fn manual_inputs_from_refs(
    direction: MatchDirection,
    refs: &[String],
    allowed_raw_extensions: &HashSet<String>,
    logs: &mut Vec<String>,
) -> Vec<MatchFile> {
    let mut inputs = Vec::new();
    let mut seen = HashSet::new();

    for raw_ref in refs {
        let Some((file_name, base_name, extension)) = normalize_manual_ref(raw_ref) else {
            continue;
        };
        if !manual_ref_matches_input_role(direction, &extension, allowed_raw_extensions) {
            logs.push(format!("跳过未启用或不支持的 RAW 文本清单项: {file_name}"));
            continue;
        }
        let key = base_name.to_ascii_lowercase();
        if !seen.insert(key) {
            logs.push(format!("跳过重复文本清单项: {file_name}"));
            continue;
        }

        inputs.push(MatchFile {
            path: format!("manual://{file_name}"),
            file_name,
            base_name,
            extension,
            size: 0,
            modified_time: None,
            manual: true,
        });
    }

    inputs
}

fn manual_ref_matches_input_role(
    direction: MatchDirection,
    extension: &str,
    allowed_raw_extensions: &HashSet<String>,
) -> bool {
    direction.input_role() != FileRole::Raw
        || extension.is_empty()
        || allowed_raw_extensions.contains(extension)
}

fn normalize_manual_ref(raw_ref: &str) -> Option<(String, String, String)> {
    let cleaned = raw_ref
        .trim()
        .trim_matches(|character| matches!(character, '"' | '\'' | '\x60' | ',' | ';'));
    if cleaned.is_empty() {
        return None;
    }

    let file_name = cleaned
        .rsplit(['/', '\\'])
        .find(|segment| !segment.is_empty())
        .unwrap_or(cleaned)
        .to_string();
    let base_name = Path::new(&file_name)
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or(&file_name)
        .to_string();
    let extension = extension_lower(Path::new(&file_name)).unwrap_or_default();

    Some((file_name, base_name, extension))
}

fn find_candidates_for_input(
    input: &MatchFile,
    candidates_by_base: &HashMap<String, Vec<MatchFile>>,
) -> Vec<MatchFile> {
    if !input.manual {
        return candidates_by_base
            .get(&input.base_name)
            .cloned()
            .unwrap_or_default();
    }

    if let Some(exact_candidates) = candidates_by_base.get(&input.base_name) {
        return exact_candidates.clone();
    }

    let suffix = input.base_name.to_ascii_lowercase();
    let mut candidates = candidates_by_base
        .iter()
        .filter(|(base_name, _)| base_name.to_ascii_lowercase().ends_with(&suffix))
        .flat_map(|(_, candidates)| candidates.clone())
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| left.path.cmp(&right.path));
    candidates
}

fn index_candidates(candidates: Vec<MatchFile>) -> HashMap<String, Vec<MatchFile>> {
    let mut candidates_by_base: HashMap<String, Vec<MatchFile>> = HashMap::new();
    for candidate in candidates {
        candidates_by_base
            .entry(candidate.base_name.clone())
            .or_default()
            .push(candidate);
    }
    for candidates in candidates_by_base.values_mut() {
        candidates.sort_by(|left, right| left.path.cmp(&right.path));
    }
    candidates_by_base
}

fn is_supported_path(
    path: &Path,
    role: FileRole,
    allowed_raw_extensions: &HashSet<String>,
) -> bool {
    extension_lower(path)
        .map(|extension| match role {
            FileRole::Image => IMAGE_EXTENSIONS.contains(&extension.as_str()),
            FileRole::Raw => allowed_raw_extensions.contains(&extension),
        })
        .unwrap_or(false)
}

fn export_files(
    direction: MatchDirection,
    results: &[MatchResult],
    export_dir: &str,
    search_root: &str,
    allowed_raw_extensions: &HashSet<String>,
) -> Result<ExportResponse, Box<dyn std::error::Error>> {
    let export_path = fs::canonicalize(export_dir)?;
    if !export_path.is_dir() {
        return Err(format!("导出目标目录不存在或不是目录: {}", export_path.display()).into());
    }

    let search_root_path = fs::canonicalize(search_root)?;
    if !search_root_path.is_dir() {
        return Err(format!("查找目录不存在或不是目录: {}", search_root_path.display()).into());
    }

    let candidate_role = direction.candidate_role();
    let mut logs = vec![format!("开始导出{}文件", candidate_role.label())];
    let mut summary = ExportSummary::default();
    let mut seen_sources = HashSet::new();
    let candidate_scan =
        collect_candidates(&search_root_path, candidate_role, allowed_raw_extensions);
    logs.push(format!(
        "导出前重新验证{}候选: {} 个文件",
        candidate_role.label(),
        candidate_scan.files.len()
    ));
    let trusted_candidates_by_base = index_candidates(candidate_scan.files);

    for result in results {
        match result.status {
            MatchStatus::Missing => {
                summary.skipped_missing_count += 1;
                logs.push(format!("跳过未找到项: {}", result.input.file_name));
            }
            MatchStatus::Conflict => {
                summary.skipped_conflict_count += 1;
                logs.push(format!("跳过未解决冲突: {}", result.input.file_name));
            }
            MatchStatus::Matched | MatchStatus::Confirmed => {
                let Some(selected) = &result.selected_candidate else {
                    summary.skipped_conflict_count += 1;
                    logs.push(format!(
                        "跳过缺少唯一候选的条目: {}",
                        result.input.file_name
                    ));
                    continue;
                };

                let selected_path = match fs::canonicalize(&selected.path) {
                    Ok(path) => path,
                    Err(error) => {
                        summary.source_error_count += 1;
                        logs.push(format!(
                            "跳过无法访问的已选文件 {}: {error}",
                            selected.file_name
                        ));
                        continue;
                    }
                };
                let selected_key = selected_path.to_string_lossy().to_string();
                let belongs_to_candidates = result.candidates.iter().any(|candidate| {
                    fs::canonicalize(&candidate.path)
                        .map(|path| path == selected_path)
                        .unwrap_or(false)
                });
                if !belongs_to_candidates {
                    summary.source_error_count += 1;
                    logs.push(format!(
                        "跳过不属于原候选集合的已选文件: {}",
                        selected.file_name
                    ));
                    continue;
                }

                let trusted_input =
                    match trusted_export_input(direction, &result.input, allowed_raw_extensions) {
                        Ok(input) => input,
                        Err(error) => {
                            summary.source_error_count += 1;
                            logs.push(format!(
                                "跳过无法重新验证的输入 {}: {error}",
                                result.input.file_name
                            ));
                            continue;
                        }
                    };
                let trusted_candidates =
                    find_candidates_for_input(&trusted_input, &trusted_candidates_by_base);
                let Some(trusted_candidate) = trusted_candidates
                    .iter()
                    .find(|candidate| candidate.path == selected_key)
                else {
                    summary.source_error_count += 1;
                    logs.push(format!(
                        "跳过不属于当前查找目录或已不再匹配的文件: {}",
                        selected.file_name
                    ));
                    continue;
                };

                let source = match validate_export_source(
                    trusted_candidate,
                    candidate_role,
                    allowed_raw_extensions,
                    &search_root_path,
                ) {
                    Ok(source) => source,
                    Err(error) => {
                        summary.source_error_count += 1;
                        logs.push(format!("跳过无效源文件 {}: {error}", selected.file_name));
                        continue;
                    }
                };

                if !seen_sources.insert(source.to_string_lossy().to_string()) {
                    logs.push(format!("跳过重复候选: {}", selected.file_name));
                    continue;
                }

                let source_file_name = match file_name(&source) {
                    Ok(file_name) => file_name,
                    Err(error) => {
                        summary.source_error_count += 1;
                        logs.push(format!("跳过无法读取文件名的源文件: {error}"));
                        continue;
                    }
                };
                let destination = export_path.join(&source_file_name);

                let initial_destination_state = match destination_state(&source, &destination) {
                    Ok(state) => state,
                    Err(error) => {
                        summary.source_error_count += 1;
                        logs.push(format!(
                            "检查导出目标失败 {}: {error}",
                            destination.display()
                        ));
                        continue;
                    }
                };
                if record_existing_destination(
                    initial_destination_state,
                    candidate_role,
                    &destination,
                    &mut summary,
                    &mut logs,
                ) {
                    continue;
                }

                match copy_to_new_destination(&source, &destination) {
                    Ok(CopyNewOutcome::Copied) => {
                        summary.copied_count += 1;
                        logs.push(format!(
                            "已导出: {} -> {}",
                            source_file_name,
                            destination.display()
                        ));
                    }
                    Ok(CopyNewOutcome::AlreadyExists) => {
                        match destination_state(&source, &destination) {
                            Ok(state)
                                if record_existing_destination(
                                    state,
                                    candidate_role,
                                    &destination,
                                    &mut summary,
                                    &mut logs,
                                ) => {}
                            Ok(DestinationState::Missing) => {
                                summary.source_error_count += 1;
                                logs.push(format!(
                                    "导出目标在并发检查期间发生变化: {}",
                                    destination.display()
                                ));
                            }
                            Ok(_) => unreachable!(),
                            Err(error) => {
                                summary.source_error_count += 1;
                                logs.push(format!(
                                    "检查并发创建的导出目标失败 {}: {error}",
                                    destination.display()
                                ));
                            }
                        }
                    }
                    Err(error) => {
                        summary.source_error_count += 1;
                        logs.push(format!(
                            "导出失败 {} -> {}: {error}",
                            source.display(),
                            destination.display()
                        ));
                    }
                }
            }
        }
    }

    logs.push(format!(
        "{}导出完成: 已复制 {}，已存在相同文件 {}，跳过未找到 {}，跳过冲突 {}，文件名冲突 {}，源文件失败 {}",
        candidate_role.label(),
        summary.copied_count,
        summary.already_present_count,
        summary.skipped_missing_count,
        summary.skipped_conflict_count,
        summary.collision_count,
        summary.source_error_count
    ));

    Ok(ExportResponse { logs, summary })
}

fn validate_export_source(
    selected: &MatchFile,
    role: FileRole,
    allowed_raw_extensions: &HashSet<String>,
    search_root: &Path,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    if selected.manual {
        return Err("手工引用不能作为导出候选".into());
    }

    let requested_source = PathBuf::from(&selected.path);
    let link_metadata = fs::symlink_metadata(&requested_source)?;
    if link_metadata.file_type().is_symlink() {
        return Err(format!("源文件不能是符号链接: {}", requested_source.display()).into());
    }
    let source = fs::canonicalize(&requested_source)?;
    if !source.starts_with(search_root) {
        return Err(format!("源文件不在当前查找目录内: {}", source.display()).into());
    }
    let metadata = fs::metadata(&source)?;
    if !metadata.is_file() {
        return Err(format!("源路径不是文件: {}", source.display()).into());
    }
    if !is_supported_path(&source, role, allowed_raw_extensions) {
        return Err(format!(
            "源文件格式不属于当前方向的{}候选: {}",
            role.label(),
            source.display()
        )
        .into());
    }
    if role == FileRole::Raw && metadata.len() < MIN_RAW_FILE_SIZE_BYTES {
        return Err(format!("RAW 源文件小于 1 MB: {}", source.display()).into());
    }

    Ok(source)
}

fn trusted_export_input(
    direction: MatchDirection,
    input: &MatchFile,
    allowed_raw_extensions: &HashSet<String>,
) -> Result<MatchFile, Box<dyn std::error::Error>> {
    if input.manual {
        let (file_name, base_name, extension) =
            normalize_manual_ref(&input.file_name).ok_or("手工文本引用为空或无效")?;
        if !manual_ref_matches_input_role(direction, &extension, allowed_raw_extensions) {
            return Err(format!("RAW 文本清单格式未启用或不受支持: {file_name}").into());
        }
        return Ok(MatchFile {
            path: format!("manual://{file_name}"),
            file_name,
            base_name,
            extension,
            size: 0,
            modified_time: None,
            manual: true,
        });
    }

    let path = Path::new(&input.path);
    let trusted = match_file_from_path(path)?;
    if !is_supported_path(path, direction.input_role(), allowed_raw_extensions) {
        return Err(format!(
            "输入文件格式不属于当前方向的{}输入: {}",
            direction.input_role().label(),
            path.display()
        )
        .into());
    }
    if direction.input_role() == FileRole::Raw && trusted.size < MIN_RAW_FILE_SIZE_BYTES {
        return Err(format!("RAW 输入文件小于 1 MB: {}", path.display()).into());
    }
    Ok(trusted)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DestinationState {
    Missing,
    Identical,
    Collision,
}

fn destination_state(
    source: &Path,
    destination: &Path,
) -> Result<DestinationState, Box<dyn std::error::Error>> {
    match fs::symlink_metadata(destination) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Ok(DestinationState::Collision);
            }
            if files_have_same_contents(source, destination)? {
                Ok(DestinationState::Identical)
            } else {
                Ok(DestinationState::Collision)
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(DestinationState::Missing),
        Err(error) => Err(error.into()),
    }
}

fn record_existing_destination(
    state: DestinationState,
    role: FileRole,
    destination: &Path,
    summary: &mut ExportSummary,
    logs: &mut Vec<String>,
) -> bool {
    match state {
        DestinationState::Missing => false,
        DestinationState::Identical => {
            summary.already_present_count += 1;
            logs.push(format!(
                "已存在相同{}文件: {}",
                role.label(),
                destination.display()
            ));
            true
        }
        DestinationState::Collision => {
            summary.collision_count += 1;
            logs.push(format!("跳过文件名冲突: {}", destination.display()));
            true
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CopyNewOutcome {
    Copied,
    AlreadyExists,
}

fn copy_to_new_destination(source: &Path, destination: &Path) -> io::Result<CopyNewOutcome> {
    let mut source_file = fs::File::open(source)?;
    let mut destination_file = match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
    {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            return Ok(CopyNewOutcome::AlreadyExists);
        }
        Err(error) => return Err(error),
    };

    if let Err(error) = io::copy(&mut source_file, &mut destination_file) {
        drop(destination_file);
        let _ = fs::remove_file(destination);
        return Err(error);
    }
    Ok(CopyNewOutcome::Copied)
}

fn generate_file_thumbnail(path: &Path) -> Result<String, Box<dyn std::error::Error>> {
    if !path.is_file() {
        return Err(format!("预览文件不存在: {}", path.display()).into());
    }
    let extension = extension_lower(path).unwrap_or_default();
    if !IMAGE_EXTENSIONS.contains(&extension.as_str())
        && !RAW_EXTENSIONS.contains(&extension.as_str())
    {
        return Err(format!("不支持预览此文件格式: {}", path.display()).into());
    }

    let cache_dir = file_thumbnail_cache_dir(path);
    fs::create_dir_all(&cache_dir)?;
    let thumbnail_path = cache_dir.join(format!("{}.png", file_name(path)?));
    if thumbnail_path.is_file() {
        return Ok(thumbnail_path.to_string_lossy().to_string());
    }

    let status = Command::new("qlmanage")
        .arg("-t")
        .arg("-s")
        .arg(FILE_THUMBNAIL_SIZE)
        .arg("-o")
        .arg(&cache_dir)
        .arg(path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?;
    if !status.success() {
        return Err(format!("生成文件缩略图失败: {}", path.display()).into());
    }
    if !thumbnail_path.is_file() {
        return Err(format!("未找到文件缩略图输出: {}", thumbnail_path.display()).into());
    }

    Ok(thumbnail_path.to_string_lossy().to_string())
}

fn file_thumbnail_cache_dir(path: &Path) -> PathBuf {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    canonical_path_string(path).hash(&mut hasher);
    if let Ok(metadata) = fs::metadata(path) {
        metadata.len().hash(&mut hasher);
        metadata.modified().ok().hash(&mut hasher);
    }
    env::temp_dir()
        .join("raw-jpeg-matcher-thumbnails")
        .join(format!("{:016x}", hasher.finish()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[cfg(unix)]
    use std::os::unix::fs::symlink;
    use std::{fs::File, io::Write, thread};
    use tempfile::tempdir;

    #[test]
    fn capabilities_and_direction_neutral_contract_use_camel_case() {
        let capabilities = matcher_capabilities();
        assert_eq!(capabilities.image_extensions, vec!["jpg", "jpeg", "png"]);
        assert_eq!(
            capabilities.raw_extensions,
            vec![
                "cr2", "cr3", "nef", "arw", "raf", "orf", "rw2", "dng", "rwl", "pef", "3fr", "iiq"
            ]
        );
        assert_eq!(
            serde_json::to_value(MatchDirection::ImageToRaw).unwrap(),
            json!("imageToRaw")
        );
        assert_eq!(
            serde_json::to_value(MatchDirection::RawToImage).unwrap(),
            json!("rawToImage")
        );
        assert_eq!(
            serde_json::to_value(MatchStatus::Confirmed).unwrap(),
            json!("confirmed")
        );

        let input = sample_file("manual://IMG_1001.JPG", "IMG_1001.JPG", "jpg", true);
        let candidate = sample_file("/tmp/IMG_1001.CR3", "IMG_1001.CR3", "cr3", false);
        let result_value = serde_json::to_value(MatchResult {
            input,
            status: MatchStatus::Matched,
            candidates: vec![candidate.clone()],
            selected_candidate: Some(candidate),
        })
        .unwrap();
        assert!(result_value.get("input").is_some());
        assert!(result_value.get("selectedCandidate").is_some());
        assert!(result_value.get("selected_candidate").is_none());

        let response_value = serde_json::to_value(MatchResponse {
            inputs: Vec::new(),
            results: Vec::new(),
            logs: Vec::new(),
            summary: MatchSummary::default(),
        })
        .unwrap();
        assert!(response_value.get("inputs").is_some());
        assert!(response_value.get("jpegInputs").is_none());

        let export_value = serde_json::to_value(ExportSummary::default()).unwrap();
        for key in [
            "copiedCount",
            "alreadyPresentCount",
            "skippedMissingCount",
            "skippedConflictCount",
            "collisionCount",
            "sourceErrorCount",
        ] {
            assert!(export_value.get(key).is_some(), "missing key {key}");
        }
    }

    #[test]
    fn thumbnail_cache_stays_in_asset_scope_and_rejects_unsupported_files() {
        let temp = tempdir().unwrap();
        let unsupported = temp.path().join("notes.txt");
        fs::write(&unsupported, b"not an image").unwrap();

        let cache_dir = file_thumbnail_cache_dir(&unsupported);
        assert!(cache_dir.starts_with(env::temp_dir().join("raw-jpeg-matcher-thumbnails")));
        assert!(generate_file_thumbnail(&unsupported)
            .unwrap_err()
            .to_string()
            .contains("不支持预览"));
    }

    #[test]
    fn image_collection_accepts_jpg_jpeg_png_and_deduplicates_paths() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("images");
        let nested = root.join("nested");
        let metadata = root.join(".Spotlight-V100");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir_all(&metadata).unwrap();
        write_bytes(&root.join("IMG_1001.JPG"), b"jpg");
        write_bytes(&nested.join("IMG_1002.JpEg"), b"jpeg");
        write_bytes(&nested.join("IMG_1003.PNG"), b"png");
        write_bytes(&nested.join("notes.txt"), b"notes");
        write_bytes(&metadata.join("HIDDEN.JPG"), b"hidden");

        let paths = vec![
            root.to_string_lossy().to_string(),
            nested.join("IMG_1002.JpEg").to_string_lossy().to_string(),
            temp.path()
                .join("missing.JPG")
                .to_string_lossy()
                .to_string(),
        ];
        let collection = collect_inputs(
            MatchDirection::ImageToRaw,
            &paths,
            &default_raw_extension_set(),
        );

        assert_eq!(collection.files.len(), 3);
        assert_eq!(collection.duplicate_count, 1);
        assert_eq!(collection.skipped_count, 2);
        assert_eq!(
            collection
                .files
                .iter()
                .map(|file| file.extension.as_str())
                .collect::<HashSet<_>>(),
            HashSet::from(["jpg", "jpeg", "png"])
        );
        assert!(!collection
            .files
            .iter()
            .any(|file| file.file_name == "HIDDEN.JPG"));
        assert!(collection.logs.iter().any(|log| log.contains("重复")));
        assert!(collection.logs.iter().any(|log| log.contains("不存在")));
    }

    #[test]
    fn image_collection_does_not_require_raw_formats_but_raw_collection_does() {
        let temp = tempdir().unwrap();
        let image_path = temp.path().join("IMG_0001.PNG");
        write_bytes(&image_path, b"png");

        let image_collection = collect_match_inputs(
            MatchDirection::ImageToRaw,
            vec![image_path.to_string_lossy().to_string()],
            Some(Vec::new()),
        )
        .unwrap();
        assert_eq!(image_collection.files.len(), 1);

        let raw_error =
            collect_match_inputs(MatchDirection::RawToImage, Vec::new(), Some(Vec::new()))
                .unwrap_err();
        assert!(raw_error.contains("至少选择一种"));
    }

    #[test]
    fn raw_collection_accepts_all_twelve_formats_and_filters_small_files() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("raws");
        fs::create_dir_all(&root).unwrap();
        for (index, extension) in RAW_EXTENSIONS.iter().enumerate() {
            let extension = if index % 2 == 0 {
                extension.to_ascii_uppercase()
            } else {
                extension.to_string()
            };
            write_sized(&root.join(format!("IMG_{index:04}.{extension}")), 1);
        }
        write_with_size(&root.join("TOO_SMALL.CR3"), 4 * 1024, 2);
        write_bytes(&root.join("preview.jpg"), b"small image");
        let metadata = root.join(".TemporaryItems");
        fs::create_dir_all(&metadata).unwrap();
        write_sized(&metadata.join("HIDDEN.NEF"), 3);

        let collection = collect_inputs(
            MatchDirection::RawToImage,
            &[root.to_string_lossy().to_string()],
            &default_raw_extension_set(),
        );

        assert_eq!(collection.files.len(), RAW_EXTENSIONS.len());
        assert_eq!(collection.skipped_count, 2);
        assert!(collection.logs.iter().any(|log| log.contains("小于 1 MB")));
        assert!(!collection
            .files
            .iter()
            .any(|file| file.file_name == "HIDDEN.NEF"));
        assert_eq!(
            collection
                .files
                .iter()
                .map(|file| file.extension.as_str())
                .collect::<HashSet<_>>(),
            RAW_EXTENSIONS.iter().copied().collect::<HashSet<_>>()
        );
    }

    #[test]
    fn raw_collection_respects_filter_and_keeps_same_base_name_in_distinct_paths() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("raws");
        let first = root.join("a/IMG_2001.CR3");
        let second = root.join("b/IMG_2001.cr3");
        let filtered = root.join("b/IMG_2001.NEF");
        write_sized(&first, 1);
        write_sized(&second, 2);
        write_sized(&filtered, 3);
        let allowed = normalize_raw_extensions(Some(vec![".CR3".to_string()])).unwrap();

        let collection = collect_inputs(
            MatchDirection::RawToImage,
            &[root.to_string_lossy().to_string()],
            &allowed,
        );

        assert_eq!(collection.files.len(), 2);
        assert_eq!(collection.duplicate_count, 0);
        assert_eq!(collection.files[0].base_name, "IMG_2001");
        assert_eq!(collection.files[1].base_name, "IMG_2001");
        assert_ne!(collection.files[0].path, collection.files[1].path);
    }

    #[test]
    fn image_to_raw_matching_is_exact_and_reports_missing_and_conflicts() {
        let temp = tempdir().unwrap();
        let image_root = temp.path().join("images");
        let raw_root = temp.path().join("raws");
        let inputs = [
            image_root.join("IMG_1001.JPG"),
            image_root.join("IMG_1002.PNG"),
            image_root.join("IMG_1003-Edit.jpeg"),
            image_root.join("IMG_CASE.JPG"),
        ];
        for input in &inputs {
            write_bytes(input, b"image");
        }
        write_sized(&raw_root.join("single/IMG_1001.CR3"), 1);
        write_sized(&raw_root.join("a/IMG_1002.NEF"), 2);
        write_sized(&raw_root.join("z/IMG_1002.CR3"), 3);
        write_sized(&raw_root.join("single/IMG_1003.CR3"), 4);
        write_sized(&raw_root.join("single/img_case.CR3"), 5);

        let response = match_files(
            MatchDirection::ImageToRaw,
            &inputs
                .iter()
                .map(|path| path.to_string_lossy().to_string())
                .collect::<Vec<_>>(),
            &raw_root.to_string_lossy(),
            &default_raw_extension_set(),
            &[],
        )
        .unwrap();

        assert_eq!(response.summary.input_count, 4);
        assert_eq!(response.summary.matched_count, 1);
        assert_eq!(response.summary.conflict_count, 1);
        assert_eq!(response.summary.missing_count, 2);
        assert_eq!(response.summary.confirmed_count, 0);

        let unique = result_named(&response, "IMG_1001.JPG");
        assert_eq!(unique.status, MatchStatus::Matched);
        assert_eq!(
            unique.selected_candidate.as_ref().unwrap().file_name,
            "IMG_1001.CR3"
        );

        let conflict = result_named(&response, "IMG_1002.PNG");
        assert_eq!(conflict.status, MatchStatus::Conflict);
        assert!(conflict.selected_candidate.is_none());
        assert_eq!(conflict.candidates.len(), 2);
        assert!(conflict.candidates[0].path < conflict.candidates[1].path);
        assert_eq!(
            result_named(&response, "IMG_1003-Edit.jpeg").status,
            MatchStatus::Missing
        );
        assert_eq!(
            result_named(&response, "IMG_CASE.JPG").status,
            MatchStatus::Missing
        );
        assert!(response.logs.iter().any(|log| log.contains("图片 → RAW")));
    }

    #[test]
    fn matching_uses_only_selected_raw_formats() {
        let temp = tempdir().unwrap();
        let image = temp.path().join("IMG_2500.JPG");
        let raw_root = temp.path().join("raws");
        write_bytes(&image, b"image");
        write_sized(&raw_root.join("IMG_2500.CR3"), 1);
        write_sized(&raw_root.join("IMG_2500.NEF"), 2);
        let selected = normalize_raw_extensions(Some(vec!["CR3".to_string()])).unwrap();

        let response = match_files(
            MatchDirection::ImageToRaw,
            &[image.to_string_lossy().to_string()],
            &raw_root.to_string_lossy(),
            &selected,
            &[],
        )
        .unwrap();

        assert_eq!(response.results[0].status, MatchStatus::Matched);
        assert_eq!(response.results[0].candidates.len(), 1);
        assert_eq!(response.results[0].candidates[0].extension, "cr3");
    }

    #[test]
    fn raw_to_image_matching_keeps_small_images_and_conflicts_across_formats() {
        let temp = tempdir().unwrap();
        let raw_root = temp.path().join("raw-inputs");
        let image_root = temp.path().join("images");
        let raw_paths = [
            raw_root.join("IMG_3001.CR3"),
            raw_root.join("IMG_3002.NEF"),
            raw_root.join("IMG_CASE.ARW"),
        ];
        for (index, path) in raw_paths.iter().enumerate() {
            write_sized(path, index as u8 + 1);
        }
        write_bytes(&image_root.join("a/IMG_3001.JPG"), b"jpg");
        write_bytes(&image_root.join("b/IMG_3001.PNG"), b"png");
        write_bytes(&image_root.join("IMG_3002.png"), b"x");
        write_bytes(&image_root.join("img_case.jpeg"), b"jpeg");

        let response = match_files(
            MatchDirection::RawToImage,
            &raw_paths
                .iter()
                .map(|path| path.to_string_lossy().to_string())
                .collect::<Vec<_>>(),
            &image_root.to_string_lossy(),
            &default_raw_extension_set(),
            &[],
        )
        .unwrap();

        assert_eq!(response.summary.conflict_count, 1);
        assert_eq!(response.summary.matched_count, 1);
        assert_eq!(response.summary.missing_count, 1);
        assert_eq!(
            result_named(&response, "IMG_3001.CR3").status,
            MatchStatus::Conflict
        );
        let small_image_match = result_named(&response, "IMG_3002.NEF");
        assert_eq!(small_image_match.status, MatchStatus::Matched);
        assert_eq!(
            small_image_match
                .selected_candidate
                .as_ref()
                .unwrap()
                .extension,
            "png"
        );
        assert_eq!(
            result_named(&response, "IMG_CASE.ARW").status,
            MatchStatus::Missing
        );
        assert!(response.logs.iter().any(|log| log.contains("RAW → 图片")));
    }

    #[test]
    fn manual_references_prefer_exact_then_match_case_insensitive_suffix() {
        let temp = tempdir().unwrap();
        let raw_root = temp.path().join("raws");
        write_sized(&raw_root.join("5022.CR3"), 1);
        write_sized(&raw_root.join("5N6A5022.NEF"), 2);

        let exact = match_files(
            MatchDirection::ImageToRaw,
            &[],
            &raw_root.to_string_lossy(),
            &default_raw_extension_set(),
            &[r"C:\client\5022.JPG".to_string()],
        )
        .unwrap();
        assert_eq!(exact.results[0].status, MatchStatus::Matched);
        assert_eq!(exact.results[0].candidates[0].file_name, "5022.CR3");
        assert_eq!(exact.results[0].input.file_name, "5022.JPG");
        assert!(exact.results[0].input.manual);

        fs::remove_file(raw_root.join("5022.CR3")).unwrap();
        let suffix = match_files(
            MatchDirection::ImageToRaw,
            &[],
            &raw_root.to_string_lossy(),
            &default_raw_extension_set(),
            &[r"C:\client\5022".to_string(), "5022.png".to_string()],
        )
        .unwrap();
        assert_eq!(suffix.summary.input_count, 1);
        assert_eq!(suffix.results[0].status, MatchStatus::Matched);
        assert_eq!(suffix.results[0].candidates[0].file_name, "5N6A5022.NEF");
        assert!(suffix.logs.iter().any(|log| log.contains("重复文本清单")));

        write_sized(&raw_root.join("PREFIXAbCd.CR3"), 3);
        let case_insensitive_suffix = match_files(
            MatchDirection::ImageToRaw,
            &[],
            &raw_root.to_string_lossy(),
            &default_raw_extension_set(),
            &["abcd".to_string()],
        )
        .unwrap();
        assert_eq!(
            case_insensitive_suffix.results[0].candidates[0].file_name,
            "PREFIXAbCd.CR3"
        );
    }

    #[test]
    fn raw_to_image_manual_references_match_images_and_honor_enabled_formats() {
        let temp = tempdir().unwrap();
        let image_root = temp.path().join("images");
        write_bytes(&image_root.join("IMG_1001.JPG"), b"jpg");
        write_bytes(&image_root.join("prefix/IMG_1002.PNG"), b"png");

        let response = match_files(
            MatchDirection::RawToImage,
            &[],
            &image_root.to_string_lossy(),
            &default_raw_extension_set(),
            &["IMG_1001.CR3".to_string(), "1002".to_string()],
        )
        .unwrap();

        assert_eq!(response.summary.input_count, 2);
        assert_eq!(response.summary.matched_count, 2);
        assert!(response.results.iter().all(|result| result.input.manual));
        assert_eq!(
            result_named(&response, "IMG_1001.CR3")
                .selected_candidate
                .as_ref()
                .unwrap()
                .file_name,
            "IMG_1001.JPG"
        );
        assert_eq!(
            result_named(&response, "1002")
                .selected_candidate
                .as_ref()
                .unwrap()
                .file_name,
            "IMG_1002.PNG"
        );

        let cr3_only = normalize_raw_extensions(Some(vec!["CR3".to_string()])).unwrap();
        let filtered = match_files(
            MatchDirection::RawToImage,
            &[],
            &image_root.to_string_lossy(),
            &cr3_only,
            &["IMG_1001.NEF".to_string()],
        )
        .unwrap_err();
        assert!(filtered.to_string().contains("没有可用于匹配的RAW输入"));
    }

    #[test]
    fn rerunning_match_never_inherits_confirmed_state() {
        let temp = tempdir().unwrap();
        let image = temp.path().join("IMG_4001.JPG");
        let raw_root = temp.path().join("raws");
        write_bytes(&image, b"image");
        write_sized(&raw_root.join("a/IMG_4001.CR3"), 1);
        write_sized(&raw_root.join("b/IMG_4001.NEF"), 2);

        let first = match_files(
            MatchDirection::ImageToRaw,
            &[image.to_string_lossy().to_string()],
            &raw_root.to_string_lossy(),
            &default_raw_extension_set(),
            &[],
        )
        .unwrap();
        assert_eq!(first.results[0].status, MatchStatus::Conflict);

        let second = match_counterpart_files(
            MatchDirection::ImageToRaw,
            first.inputs,
            None,
            raw_root.to_string_lossy().to_string(),
            None,
        )
        .unwrap();
        assert_eq!(second.results[0].status, MatchStatus::Conflict);
        assert_eq!(second.summary.confirmed_count, 0);
        assert!(second.results[0].selected_candidate.is_none());
    }

    #[test]
    fn export_supports_both_directions() {
        let temp = tempdir().unwrap();

        let image_input_path = temp.path().join("IMG_5001.JPG");
        let raw_candidate_path = temp.path().join("raws/IMG_5001.CR3");
        let raw_export_dir = temp.path().join("raw-export");
        write_bytes(&image_input_path, b"image");
        write_sized(&raw_candidate_path, 1);
        fs::create_dir_all(&raw_export_dir).unwrap();
        let image_input = match_file_from_path(&image_input_path).unwrap();
        let raw_candidate = match_file_from_path(&raw_candidate_path).unwrap();

        let raw_response = export_files(
            MatchDirection::ImageToRaw,
            &[selected_result(
                &image_input,
                &raw_candidate,
                MatchStatus::Matched,
            )],
            &raw_export_dir.to_string_lossy(),
            &temp.path().join("raws").to_string_lossy(),
            &default_raw_extension_set(),
        )
        .unwrap();
        assert_eq!(raw_response.summary.copied_count, 1);
        assert!(raw_export_dir.join("IMG_5001.CR3").is_file());

        let raw_input_path = temp.path().join("raw-inputs/IMG_5002.NEF");
        let image_candidate_path = temp.path().join("images/IMG_5002.PNG");
        let image_export_dir = temp.path().join("image-export");
        write_sized(&raw_input_path, 2);
        write_bytes(&image_candidate_path, b"png");
        fs::create_dir_all(&image_export_dir).unwrap();
        let raw_input = match_file_from_path(&raw_input_path).unwrap();
        let image_candidate = match_file_from_path(&image_candidate_path).unwrap();

        let image_response = export_files(
            MatchDirection::RawToImage,
            &[selected_result(
                &raw_input,
                &image_candidate,
                MatchStatus::Confirmed,
            )],
            &image_export_dir.to_string_lossy(),
            &temp.path().join("images").to_string_lossy(),
            &default_raw_extension_set(),
        )
        .unwrap();
        assert_eq!(image_response.summary.copied_count, 1);
        assert!(image_export_dir.join("IMG_5002.PNG").is_file());
    }

    #[test]
    fn export_processes_duplicate_selected_path_only_once() {
        let temp = tempdir().unwrap();
        let export_dir = temp.path().join("export");
        fs::create_dir_all(&export_dir).unwrap();
        let first_input_path = temp.path().join("first/IMG_6001.JPG");
        let second_input_path = temp.path().join("second/IMG_6001.PNG");
        let candidate_path = temp.path().join("raws/IMG_6001.CR3");
        write_bytes(&first_input_path, b"first");
        write_bytes(&second_input_path, b"second");
        write_sized(&candidate_path, 1);
        let first_input = match_file_from_path(&first_input_path).unwrap();
        let second_input = match_file_from_path(&second_input_path).unwrap();
        let candidate = match_file_from_path(&candidate_path).unwrap();

        let response = export_files(
            MatchDirection::ImageToRaw,
            &[
                selected_result(&first_input, &candidate, MatchStatus::Matched),
                selected_result(&second_input, &candidate, MatchStatus::Confirmed),
            ],
            &export_dir.to_string_lossy(),
            &temp.path().join("raws").to_string_lossy(),
            &default_raw_extension_set(),
        )
        .unwrap();

        assert_eq!(response.summary.copied_count, 1);
        assert_eq!(response.summary.already_present_count, 0);
        assert_eq!(response.summary.collision_count, 0);
        assert!(response.logs.iter().any(|log| log.contains("重复候选")));
    }

    #[test]
    fn export_distinguishes_copy_already_present_and_collision() {
        let temp = tempdir().unwrap();
        let export_dir = temp.path().join("export");
        fs::create_dir_all(&export_dir).unwrap();
        let input_path = temp.path().join("IMG_7000.JPG");
        write_bytes(&input_path, b"input");
        let input = match_file_from_path(&input_path).unwrap();

        let already_path = temp.path().join("raws/IMG_7000.CR3");
        let collision_path = temp.path().join("raws/IMG_7000.NEF");
        let copied_path = temp.path().join("raws/IMG_7000.ARW");
        write_sized(&already_path, 1);
        write_sized(&collision_path, 2);
        write_sized(&copied_path, 3);
        fs::copy(&already_path, export_dir.join("IMG_7000.CR3")).unwrap();
        write_with_size(
            &export_dir.join("IMG_7000.NEF"),
            MIN_RAW_FILE_SIZE_BYTES + 1,
            9,
        );

        let results = [&already_path, &collision_path, &copied_path]
            .iter()
            .map(|path| {
                let candidate = match_file_from_path(path).unwrap();
                selected_result(&input, &candidate, MatchStatus::Matched)
            })
            .collect::<Vec<_>>();
        let response = export_files(
            MatchDirection::ImageToRaw,
            &results,
            &export_dir.to_string_lossy(),
            &temp.path().join("raws").to_string_lossy(),
            &default_raw_extension_set(),
        )
        .unwrap();

        assert_eq!(response.summary.copied_count, 1);
        assert_eq!(response.summary.already_present_count, 1);
        assert_eq!(response.summary.collision_count, 1);
        assert_eq!(response.summary.source_error_count, 0);
        assert!(export_dir.join("IMG_7000.ARW").is_file());
    }

    #[test]
    fn export_records_item_errors_and_continues_with_remaining_candidates() {
        let temp = tempdir().unwrap();
        let export_dir = temp.path().join("export");
        fs::create_dir_all(&export_dir).unwrap();
        let input_path = temp.path().join("IMG_8000.JPG");
        let good_path = temp.path().join("raws/IMG_8000.CR3");
        let unrelated_path = temp.path().join("raws/UNRELATED.NEF");
        let wrong_role_path = temp.path().join("images/IMG_8000.JPG");
        write_bytes(&input_path, b"input");
        write_sized(&good_path, 1);
        write_sized(&unrelated_path, 2);
        write_bytes(&wrong_role_path, b"image");
        let input = match_file_from_path(&input_path).unwrap();
        let good = match_file_from_path(&good_path).unwrap();
        let unrelated = match_file_from_path(&unrelated_path).unwrap();
        let wrong_role = match_file_from_path(&wrong_role_path).unwrap();
        let missing = sample_file(
            &temp.path().join("raws/IMG_8000.NEF").to_string_lossy(),
            "IMG_8000.NEF",
            "cr3",
            false,
        );

        let mut selected_outside_candidates = selected_result(&input, &good, MatchStatus::Matched);
        selected_outside_candidates.selected_candidate = Some(unrelated);

        let results = vec![
            selected_result(&input, &missing, MatchStatus::Matched),
            selected_outside_candidates,
            selected_result(&input, &wrong_role, MatchStatus::Matched),
            MatchResult {
                input: input.clone(),
                status: MatchStatus::Missing,
                candidates: Vec::new(),
                selected_candidate: None,
            },
            MatchResult {
                input: input.clone(),
                status: MatchStatus::Conflict,
                candidates: Vec::new(),
                selected_candidate: None,
            },
            selected_result(&input, &good, MatchStatus::Matched),
        ];
        let response = export_files(
            MatchDirection::ImageToRaw,
            &results,
            &export_dir.to_string_lossy(),
            &temp.path().join("raws").to_string_lossy(),
            &default_raw_extension_set(),
        )
        .unwrap();

        assert_eq!(response.summary.copied_count, 1);
        assert_eq!(response.summary.source_error_count, 3);
        assert_eq!(response.summary.skipped_missing_count, 1);
        assert_eq!(response.summary.skipped_conflict_count, 1);
        assert!(export_dir.join("IMG_8000.CR3").is_file());
        assert!(response.logs.iter().any(|log| log.contains("原候选集合")));
        assert!(response.logs.iter().any(|log| log.contains("当前查找目录")));
    }

    #[test]
    fn export_revalidates_candidates_against_search_root_components() {
        let temp = tempdir().unwrap();
        let search_root = temp.path().join("search/a");
        let sibling_prefix = temp.path().join("search/ab");
        let export_dir = temp.path().join("export");
        fs::create_dir_all(&search_root).unwrap();
        fs::create_dir_all(&export_dir).unwrap();

        let outside_input_path = temp.path().join("inputs/IMG_8100.JPG");
        let outside_candidate_path = sibling_prefix.join("IMG_8100.CR3");
        let nested_input_path = temp.path().join("inputs/IMG_8101.PNG");
        let nested_candidate_path = search_root.join("nested/IMG_8101.NEF");
        write_bytes(&outside_input_path, b"outside input");
        write_sized(&outside_candidate_path, 1);
        write_bytes(&nested_input_path, b"nested input");
        write_sized(&nested_candidate_path, 2);

        let outside_result = selected_result(
            &match_file_from_path(&outside_input_path).unwrap(),
            &match_file_from_path(&outside_candidate_path).unwrap(),
            MatchStatus::Matched,
        );
        let nested_result = selected_result(
            &match_file_from_path(&nested_input_path).unwrap(),
            &match_file_from_path(&nested_candidate_path).unwrap(),
            MatchStatus::Matched,
        );

        let response = export_files(
            MatchDirection::ImageToRaw,
            &[outside_result, nested_result],
            &export_dir.to_string_lossy(),
            &search_root.to_string_lossy(),
            &default_raw_extension_set(),
        )
        .unwrap();

        assert_eq!(response.summary.copied_count, 1);
        assert_eq!(response.summary.source_error_count, 1);
        assert!(!export_dir.join("IMG_8100.CR3").exists());
        assert!(export_dir.join("IMG_8101.NEF").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn export_rejects_candidate_symlink_that_points_outside_search_root() {
        let temp = tempdir().unwrap();
        let search_root = temp.path().join("raws");
        let export_dir = temp.path().join("export");
        let input_path = temp.path().join("inputs/IMG_8200.JPG");
        let outside_path = temp.path().join("outside/IMG_8200.CR3");
        let link_path = search_root.join("IMG_8200.CR3");
        fs::create_dir_all(&search_root).unwrap();
        fs::create_dir_all(&export_dir).unwrap();
        write_bytes(&input_path, b"input");
        write_sized(&outside_path, 3);
        symlink(&outside_path, &link_path).unwrap();

        let result = selected_result(
            &match_file_from_path(&input_path).unwrap(),
            &match_file_from_path(&link_path).unwrap(),
            MatchStatus::Matched,
        );
        let response = export_files(
            MatchDirection::ImageToRaw,
            &[result],
            &export_dir.to_string_lossy(),
            &search_root.to_string_lossy(),
            &default_raw_extension_set(),
        )
        .unwrap();

        assert_eq!(response.summary.copied_count, 0);
        assert_eq!(response.summary.source_error_count, 1);
        assert!(!export_dir.join("IMG_8200.CR3").exists());
        assert!(outside_path.is_file());
    }

    #[cfg(unix)]
    #[test]
    fn export_never_follows_destination_symlinks() {
        let temp = tempdir().unwrap();
        let search_root = temp.path().join("raws");
        let export_dir = temp.path().join("export");
        fs::create_dir_all(&search_root).unwrap();
        fs::create_dir_all(&export_dir).unwrap();

        let dangling_input_path = temp.path().join("inputs/IMG_8300.JPG");
        let dangling_source_path = search_root.join("IMG_8300.CR3");
        let dangling_external_path = temp.path().join("outside/not-created.CR3");
        write_bytes(&dangling_input_path, b"input");
        write_sized(&dangling_source_path, 4);
        symlink(&dangling_external_path, export_dir.join("IMG_8300.CR3")).unwrap();

        let existing_input_path = temp.path().join("inputs/IMG_8301.PNG");
        let existing_source_path = search_root.join("IMG_8301.NEF");
        let existing_external_path = temp.path().join("outside/existing.NEF");
        write_bytes(&existing_input_path, b"input");
        write_sized(&existing_source_path, 5);
        write_bytes(&existing_external_path, b"must stay unchanged");
        symlink(&existing_external_path, export_dir.join("IMG_8301.NEF")).unwrap();

        let results = vec![
            selected_result(
                &match_file_from_path(&dangling_input_path).unwrap(),
                &match_file_from_path(&dangling_source_path).unwrap(),
                MatchStatus::Matched,
            ),
            selected_result(
                &match_file_from_path(&existing_input_path).unwrap(),
                &match_file_from_path(&existing_source_path).unwrap(),
                MatchStatus::Matched,
            ),
        ];
        let response = export_files(
            MatchDirection::ImageToRaw,
            &results,
            &export_dir.to_string_lossy(),
            &search_root.to_string_lossy(),
            &default_raw_extension_set(),
        )
        .unwrap();

        assert_eq!(response.summary.copied_count, 0);
        assert_eq!(response.summary.collision_count, 2);
        assert!(!dangling_external_path.exists());
        assert_eq!(
            fs::read(&existing_external_path).unwrap(),
            b"must stay unchanged"
        );
        assert!(fs::symlink_metadata(export_dir.join("IMG_8300.CR3"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(fs::symlink_metadata(export_dir.join("IMG_8301.NEF"))
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn export_rejects_raw_format_removed_after_matching() {
        let temp = tempdir().unwrap();
        let search_root = temp.path().join("raws");
        let export_dir = temp.path().join("export");
        let input_path = temp.path().join("inputs/IMG_8400.JPG");
        let source_path = search_root.join("IMG_8400.CR3");
        fs::create_dir_all(&export_dir).unwrap();
        write_bytes(&input_path, b"input");
        write_sized(&source_path, 6);
        let result = selected_result(
            &match_file_from_path(&input_path).unwrap(),
            &match_file_from_path(&source_path).unwrap(),
            MatchStatus::Matched,
        );
        let only_nef = HashSet::from(["nef".to_string()]);

        let response = export_files(
            MatchDirection::ImageToRaw,
            &[result],
            &export_dir.to_string_lossy(),
            &search_root.to_string_lossy(),
            &only_nef,
        )
        .unwrap();

        assert_eq!(response.summary.copied_count, 0);
        assert_eq!(response.summary.source_error_count, 1);
        assert!(!export_dir.join("IMG_8400.CR3").exists());
    }

    #[test]
    fn concurrent_exports_atomically_create_only_one_destination() {
        let temp = tempdir().unwrap();
        let search_root = temp.path().join("raws");
        let export_dir = temp.path().join("export");
        let input_path = temp.path().join("inputs/IMG_8500.JPG");
        let source_path = search_root.join("IMG_8500.CR3");
        fs::create_dir_all(&export_dir).unwrap();
        write_bytes(&input_path, b"input");
        write_sized(&source_path, 7);
        let results = vec![selected_result(
            &match_file_from_path(&input_path).unwrap(),
            &match_file_from_path(&source_path).unwrap(),
            MatchStatus::Matched,
        )];
        let export_dir = export_dir.to_string_lossy().to_string();
        let search_root = search_root.to_string_lossy().to_string();
        let allowed = default_raw_extension_set();

        let (first, second) = thread::scope(|scope| {
            let first = scope.spawn(|| {
                export_files(
                    MatchDirection::ImageToRaw,
                    &results,
                    &export_dir,
                    &search_root,
                    &allowed,
                )
                .unwrap()
            });
            let second = scope.spawn(|| {
                export_files(
                    MatchDirection::ImageToRaw,
                    &results,
                    &export_dir,
                    &search_root,
                    &allowed,
                )
                .unwrap()
            });
            (first.join().unwrap(), second.join().unwrap())
        });

        assert_eq!(first.summary.copied_count + second.summary.copied_count, 1);
        assert_eq!(
            first.summary.already_present_count
                + second.summary.already_present_count
                + first.summary.collision_count
                + second.summary.collision_count,
            1
        );
        assert!(files_have_same_contents(
            &source_path,
            &Path::new(&export_dir).join("IMG_8500.CR3")
        )
        .unwrap());
    }

    #[test]
    fn matching_rejects_when_all_physical_inputs_disappear() {
        let temp = tempdir().unwrap();
        let input_path = temp.path().join("inputs/IMG_8600.JPG");
        let search_root = temp.path().join("raws");
        write_bytes(&input_path, b"input");
        fs::create_dir_all(&search_root).unwrap();
        fs::remove_file(&input_path).unwrap();

        let error = match_files(
            MatchDirection::ImageToRaw,
            &[input_path.to_string_lossy().to_string()],
            &search_root.to_string_lossy(),
            &default_raw_extension_set(),
            &[],
        )
        .unwrap_err();

        assert!(error.to_string().contains("没有可用于匹配的图片输入"));
    }

    fn result_named<'a>(response: &'a MatchResponse, file_name: &str) -> &'a MatchResult {
        response
            .results
            .iter()
            .find(|result| result.input.file_name == file_name)
            .unwrap()
    }

    fn selected_result(
        input: &MatchFile,
        candidate: &MatchFile,
        status: MatchStatus,
    ) -> MatchResult {
        MatchResult {
            input: input.clone(),
            status,
            candidates: vec![candidate.clone()],
            selected_candidate: Some(candidate.clone()),
        }
    }

    fn sample_file(path: &str, file_name: &str, extension: &str, manual: bool) -> MatchFile {
        MatchFile {
            path: path.to_string(),
            file_name: file_name.to_string(),
            base_name: Path::new(file_name)
                .file_stem()
                .unwrap()
                .to_string_lossy()
                .to_string(),
            extension: extension.to_string(),
            size: 0,
            modified_time: None,
            manual,
        }
    }

    fn write_bytes(path: &Path, bytes: &[u8]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let mut file = File::create(path).unwrap();
        file.write_all(bytes).unwrap();
    }

    fn write_sized(path: &Path, marker: u8) {
        write_with_size(path, MIN_RAW_FILE_SIZE_BYTES + 1, marker);
    }

    fn write_with_size(path: &Path, size: u64, marker: u8) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let mut file = File::create(path).unwrap();
        file.write_all(&[marker]).unwrap();
        file.set_len(size).unwrap();
    }
}
