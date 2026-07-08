use std::{
    fs,
    io::{BufReader, Read},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

const FILE_COMPARE_BUFFER_SIZE: usize = 64 * 1024;

pub(crate) fn safe_relative_path(relative_path: &str, source_path: &Path) -> PathBuf {
    let candidate = PathBuf::from(relative_path);
    if candidate.is_absolute()
        || candidate
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return PathBuf::from(
            source_path
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| "watermarked-image".to_string()),
        );
    }
    candidate
}

pub(crate) fn files_have_same_contents(
    left: &Path,
    right: &Path,
) -> Result<bool, Box<dyn std::error::Error>> {
    let left_metadata = fs::metadata(left)?;
    let right_metadata = fs::metadata(right)?;
    if left_metadata.len() != right_metadata.len() {
        return Ok(false);
    }

    let mut left_reader = BufReader::new(fs::File::open(left)?);
    let mut right_reader = BufReader::new(fs::File::open(right)?);
    let mut left_buffer = vec![0; FILE_COMPARE_BUFFER_SIZE];
    let mut right_buffer = vec![0; FILE_COMPARE_BUFFER_SIZE];

    loop {
        let left_read = left_reader.read(&mut left_buffer)?;
        let right_read = right_reader.read(&mut right_buffer)?;
        if left_read != right_read {
            return Ok(false);
        }
        if left_read == 0 {
            return Ok(true);
        }
        if left_buffer[..left_read] != right_buffer[..right_read] {
            return Ok(false);
        }
    }
}

pub(crate) fn is_macos_metadata_dir(path: &Path) -> bool {
    if !path.is_dir() {
        return false;
    }

    matches!(
        path.file_name().and_then(|name| name.to_str()),
        Some(".Spotlight-V100" | ".Trashes" | ".fseventsd" | ".TemporaryItems")
    )
}

pub(crate) fn extension_lower(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
}

pub(crate) fn file_name(path: &Path) -> Result<String, Box<dyn std::error::Error>> {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .ok_or_else(|| format!("无法读取文件名: {}", path.display()).into())
}

pub(crate) fn base_name(path: &Path) -> Result<String, Box<dyn std::error::Error>> {
    path.file_stem()
        .map(|name| name.to_string_lossy().to_string())
        .ok_or_else(|| format!("无法读取主文件名: {}", path.display()).into())
}

pub(crate) fn canonical_path_string(path: &Path) -> String {
    fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string()
}

pub(crate) fn modified_seconds(metadata: &fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
}
