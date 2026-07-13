use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io,
    path::{Path, PathBuf},
};
use walkdir::WalkDir;

use crate::{
    raw_matcher::{IMAGE_EXTENSIONS, RAW_EXTENSIONS},
    shared::{
        canonical_path_string, extension_lower, file_name, files_have_same_contents,
        is_macos_metadata_dir, modified_seconds,
    },
};

const IMAGE_DIRECTORY_NAME: &str = "图片";
const RAW_DIRECTORY_NAME: &str = "RAW";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SeparatedFileKind {
    Image,
    Raw,
}

impl SeparatedFileKind {
    fn directory_name(self) -> &'static str {
        match self {
            Self::Image => IMAGE_DIRECTORY_NAME,
            Self::Raw => RAW_DIRECTORY_NAME,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Image => "图片",
            Self::Raw => "RAW",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SeparatedFile {
    pub path: String,
    pub file_name: String,
    pub relative_path: String,
    pub extension: String,
    pub size: u64,
    pub modified_time: Option<u64>,
    pub kind: SeparatedFileKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SeparatorScanResponse {
    pub root_dir: String,
    pub images: Vec<SeparatedFile>,
    pub raws: Vec<SeparatedFile>,
    pub logs: Vec<String>,
    pub skipped_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SeparatorExportSummary {
    pub copied_count: usize,
    pub copied_image_count: usize,
    pub copied_raw_count: usize,
    pub already_present_count: usize,
    pub collision_count: usize,
    pub failed_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SeparatorExportResponse {
    pub logs: Vec<String>,
    pub summary: SeparatorExportSummary,
}

#[tauri::command]
pub(crate) fn scan_separator_source(root: String) -> Result<SeparatorScanResponse, String> {
    scan_source_directory(&root).map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn export_separated_files(
    input_root: String,
    files: Vec<SeparatedFile>,
    export_dir: String,
) -> Result<SeparatorExportResponse, String> {
    copy_separated_files(&input_root, &files, &export_dir).map_err(|error| error.to_string())
}

fn scan_source_directory(root: &str) -> Result<SeparatorScanResponse, Box<dyn std::error::Error>> {
    let root_path = fs::canonicalize(root)?;
    if !root_path.is_dir() {
        return Err(format!("混合文件夹不存在或不是目录: {}", root_path.display()).into());
    }

    let mut images = Vec::new();
    let mut raws = Vec::new();
    let mut logs = Vec::new();
    let mut skipped_count = 0;

    for entry in WalkDir::new(&root_path)
        .into_iter()
        .filter_entry(|entry| !is_macos_metadata_dir(entry.path()))
    {
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
        let Some(kind) = classify_file(path) else {
            skipped_count += 1;
            continue;
        };
        let relative_path = match path.strip_prefix(&root_path) {
            Ok(path) => path,
            Err(error) => {
                skipped_count += 1;
                logs.push(format!(
                    "跳过无法计算相对路径的文件 {}: {error}",
                    path.display()
                ));
                continue;
            }
        };
        match separated_file_from_path(path, relative_path, kind) {
            Ok(file) => match kind {
                SeparatedFileKind::Image => images.push(file),
                SeparatedFileKind::Raw => raws.push(file),
            },
            Err(error) => {
                skipped_count += 1;
                logs.push(format!("跳过无法读取的文件 {}: {error}", path.display()));
            }
        }
    }

    images.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    raws.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    if skipped_count > 0 {
        logs.push(format!(
            "已跳过 {skipped_count} 个非图片/RAW 或无法访问的文件"
        ));
    }
    logs.push(format!(
        "混合文件夹扫描完成：图片 {} 个，RAW {} 个",
        images.len(),
        raws.len()
    ));

    Ok(SeparatorScanResponse {
        root_dir: canonical_path_string(&root_path),
        images,
        raws,
        logs,
        skipped_count,
    })
}

fn copy_separated_files(
    input_root: &str,
    files: &[SeparatedFile],
    export_dir: &str,
) -> Result<SeparatorExportResponse, Box<dyn std::error::Error>> {
    let input_root_path = fs::canonicalize(input_root)?;
    if !input_root_path.is_dir() {
        return Err(format!("混合文件夹不存在或不是目录: {}", input_root_path.display()).into());
    }
    let export_path = fs::canonicalize(export_dir)?;
    if !export_path.is_dir() {
        return Err(format!("输出目录不存在或不是目录: {}", export_path.display()).into());
    }
    if export_path.starts_with(&input_root_path) {
        return Err("输出目录不能位于混合文件夹内，以免下次扫描包含已分离副本".into());
    }

    let mut logs = vec![format!("开始分离复制：{} 个文件", files.len())];
    let mut summary = SeparatorExportSummary::default();

    for file in files {
        let source = match trusted_source(file, &input_root_path) {
            Ok(source) => source,
            Err(error) => {
                summary.failed_count += 1;
                logs.push(format!("跳过无效源文件 {}: {error}", file.file_name));
                continue;
            }
        };
        let relative_path = match source.strip_prefix(&input_root_path) {
            Ok(path) => path,
            Err(error) => {
                summary.failed_count += 1;
                logs.push(format!(
                    "跳过无法计算相对路径的文件 {}: {error}",
                    source.display()
                ));
                continue;
            }
        };
        let destination = export_path
            .join(file.kind.directory_name())
            .join(relative_path);

        match destination_state(&source, &destination) {
            Ok(DestinationState::Identical) => {
                summary.already_present_count += 1;
                logs.push(format!(
                    "目标已存在相同{}文件: {}",
                    file.kind.label(),
                    destination.display()
                ));
            }
            Ok(DestinationState::Collision) => {
                summary.collision_count += 1;
                logs.push(format!("跳过文件冲突: {}", destination.display()));
            }
            Ok(DestinationState::Missing) => match copy_to_new_destination(&source, &destination) {
                Ok(CopyNewOutcome::Copied) => {
                    summary.copied_count += 1;
                    match file.kind {
                        SeparatedFileKind::Image => summary.copied_image_count += 1,
                        SeparatedFileKind::Raw => summary.copied_raw_count += 1,
                    }
                    logs.push(format!(
                        "已复制{}文件: {} -> {}",
                        file.kind.label(),
                        source.display(),
                        destination.display()
                    ));
                }
                Ok(CopyNewOutcome::AlreadyExists) => match destination_state(&source, &destination)
                {
                    Ok(DestinationState::Identical) => {
                        summary.already_present_count += 1;
                        logs.push(format!(
                            "目标已存在相同{}文件: {}",
                            file.kind.label(),
                            destination.display()
                        ));
                    }
                    Ok(DestinationState::Collision) | Ok(DestinationState::Missing) => {
                        summary.collision_count += 1;
                        logs.push(format!("跳过并发文件冲突: {}", destination.display()));
                    }
                    Err(error) => {
                        summary.failed_count += 1;
                        logs.push(format!(
                            "检查并发创建的目标失败 {}: {error}",
                            destination.display()
                        ));
                    }
                },
                Err(error) => {
                    summary.failed_count += 1;
                    logs.push(format!(
                        "复制{}文件失败 {} -> {}: {error}",
                        file.kind.label(),
                        source.display(),
                        destination.display()
                    ));
                }
            },
            Err(error) => {
                summary.failed_count += 1;
                logs.push(format!(
                    "检查输出目标失败 {}: {error}",
                    destination.display()
                ));
            }
        }
    }

    logs.push(format!(
        "分离完成：已复制 {}（图片 {}，RAW {}），已存在相同文件 {}，冲突 {}，失败 {}",
        summary.copied_count,
        summary.copied_image_count,
        summary.copied_raw_count,
        summary.already_present_count,
        summary.collision_count,
        summary.failed_count
    ));

    Ok(SeparatorExportResponse { logs, summary })
}

fn classify_file(path: &Path) -> Option<SeparatedFileKind> {
    let extension = extension_lower(path)?;
    if IMAGE_EXTENSIONS.contains(&extension.as_str()) {
        Some(SeparatedFileKind::Image)
    } else if RAW_EXTENSIONS.contains(&extension.as_str()) {
        Some(SeparatedFileKind::Raw)
    } else {
        None
    }
}

fn separated_file_from_path(
    path: &Path,
    relative_path: &Path,
    kind: SeparatedFileKind,
) -> Result<SeparatedFile, Box<dyn std::error::Error>> {
    let metadata = fs::metadata(path)?;
    Ok(SeparatedFile {
        path: canonical_path_string(path),
        file_name: file_name(path)?,
        relative_path: relative_path.to_string_lossy().to_string(),
        extension: extension_lower(path).ok_or("文件缺少扩展名")?,
        size: metadata.len(),
        modified_time: modified_seconds(&metadata),
        kind,
    })
}

fn trusted_source(
    file: &SeparatedFile,
    input_root: &Path,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let requested_path = PathBuf::from(&file.path);
    let metadata = fs::symlink_metadata(&requested_path)?;
    if metadata.file_type().is_symlink() {
        return Err(format!("源文件不能是符号链接: {}", requested_path.display()).into());
    }
    let source = fs::canonicalize(&requested_path)?;
    if !source.starts_with(input_root) {
        return Err(format!("源文件不在当前混合文件夹内: {}", source.display()).into());
    }
    if !fs::metadata(&source)?.is_file() {
        return Err(format!("源路径不是文件: {}", source.display()).into());
    }
    if classify_file(&source) != Some(file.kind) {
        return Err(format!("源文件格式与分离类型不一致: {}", source.display()).into());
    }
    Ok(source)
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CopyNewOutcome {
    Copied,
    AlreadyExists,
}

fn copy_to_new_destination(source: &Path, destination: &Path) -> io::Result<CopyNewOutcome> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write_file(path: &Path, contents: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    #[test]
    fn scan_groups_supported_files_and_preserves_relative_paths() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("source");
        write_file(&source.join("day-one/IMG_0001.JPG"), b"image");
        write_file(&source.join("day-one/IMG_0001.CR3"), b"raw");
        write_file(&source.join("day-two/notes.txt"), b"ignore");

        let response = scan_source_directory(source.to_str().unwrap()).unwrap();

        assert_eq!(response.images.len(), 1);
        assert_eq!(response.raws.len(), 1);
        assert_eq!(response.images[0].relative_path, "day-one/IMG_0001.JPG");
        assert_eq!(response.raws[0].relative_path, "day-one/IMG_0001.CR3");
        assert_eq!(response.skipped_count, 1);
    }

    #[test]
    fn export_copies_into_type_directories_without_changing_sources() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("source");
        let output = temp.path().join("output");
        fs::create_dir_all(&output).unwrap();
        let image_path = source.join("day-one/IMG_0001.JPG");
        let raw_path = source.join("day-one/IMG_0001.CR3");
        write_file(&image_path, b"image-content");
        write_file(&raw_path, b"raw-content");
        let scan = scan_source_directory(source.to_str().unwrap()).unwrap();
        let files = scan
            .images
            .iter()
            .chain(scan.raws.iter())
            .cloned()
            .collect::<Vec<_>>();

        let response =
            copy_separated_files(&scan.root_dir, &files, output.to_str().unwrap()).unwrap();

        assert_eq!(response.summary.copied_count, 2);
        assert_eq!(response.summary.copied_image_count, 1);
        assert_eq!(response.summary.copied_raw_count, 1);
        assert_eq!(fs::read(&image_path).unwrap(), b"image-content");
        assert_eq!(fs::read(&raw_path).unwrap(), b"raw-content");
        assert_eq!(
            fs::read(output.join("图片/day-one/IMG_0001.JPG")).unwrap(),
            b"image-content"
        );
        assert_eq!(
            fs::read(output.join("RAW/day-one/IMG_0001.CR3")).unwrap(),
            b"raw-content"
        );
    }

    #[test]
    fn export_rejects_output_inside_source_directory() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("source");
        let nested_output = source.join("separated");
        fs::create_dir_all(&nested_output).unwrap();
        write_file(&source.join("IMG_0001.JPG"), b"image");
        let scan = scan_source_directory(source.to_str().unwrap()).unwrap();

        let error = copy_separated_files(
            &scan.root_dir,
            &scan.images,
            nested_output.to_str().unwrap(),
        )
        .unwrap_err();

        assert!(error.to_string().contains("不能位于混合文件夹内"));
    }
}
