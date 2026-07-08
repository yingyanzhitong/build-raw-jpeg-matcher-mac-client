use ab_glyph::{Font, FontArc, FontVec, GlyphId, PxScale};
use fast_image_resize as fr;
use fontdb::{Database, Family, Query, Weight};
use image::{DynamicImage, ImageBuffer, Rgba, RgbaImage};
use imageproc::{
    compose::overlay_mut,
    drawing::{draw_text_mut, text_size},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    env, fs,
    hash::{Hash, Hasher},
    io::{BufReader, Read},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::UNIX_EPOCH,
};
use walkdir::WalkDir;

const JPEG_EXTENSIONS: &[&str] = &["jpg", "jpeg"];
const WATERMARK_IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png"];
const RAW_EXTENSIONS: &[&str] = &[
    "cr2", "cr3", "nef", "arw", "raf", "orf", "rw2", "dng", "rwl", "pef", "3fr", "iiq",
];
const MIN_RAW_FILE_SIZE_BYTES: u64 = 1024 * 1024;
const FILE_COMPARE_BUFFER_SIZE: usize = 64 * 1024;
const RAW_THUMBNAIL_SIZE: &str = "96";
const WATERMARK_TEXT_FONT_SIZE: f32 = 72.0;
const WATERMARK_TEXT_PADDING: u32 = 52;
const WATERMARK_TEXT_MIN_WIDTH: u32 = 240;
const WATERMARK_TEXT_LINE_HEIGHT_RATIO: f32 = 1.22;
const WATERMARK_TEXT_FONT_FAMILIES: &[&str] = &[
    "PingFang SC",
    "Hiragino Sans GB",
    "Microsoft YaHei",
    "Noto Sans CJK SC",
    "Source Han Sans SC",
    "Heiti SC",
    "STHeiti",
    "Songti SC",
    "Arial Unicode MS",
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WatermarkImageInput {
    pub path: String,
    pub file_name: String,
    pub relative_path: String,
    pub size: u64,
    pub modified_time: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WatermarkScanResponse {
    pub root_dir: String,
    pub images: Vec<WatermarkImageInput>,
    pub logs: Vec<String>,
    pub skipped_count: usize,
    pub duplicate_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WatermarkConfig {
    pub opacity: f32,
    pub size_percent: f32,
    pub auto_remove_background: bool,
    pub background_tolerance: f32,
    pub edge_feather: u32,
    pub shadow_strength: f32,
    pub layout: WatermarkLayout,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WatermarkLayout {
    Single,
    Tile,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum WatermarkSource {
    Text {
        text: String,
    },
    TextBitmap {
        width: u32,
        height: u32,
        pixels: Vec<u8>,
    },
    ImageFile {
        path: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WatermarkExportSummary {
    pub exported_count: usize,
    pub skipped_count: usize,
    pub failed_count: usize,
    pub collision_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WatermarkExportResponse {
    pub logs: Vec<String>,
    pub summary: WatermarkExportSummary,
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
fn export_raw_files(
    results: Vec<MatchResult>,
    export_dir: String,
) -> Result<ExportResponse, String> {
    export_files(&results, &export_dir).map_err(|error| error.to_string())
}

#[tauri::command]
fn scan_watermark_images(root: String) -> Result<WatermarkScanResponse, String> {
    scan_watermark_directory(&root).map_err(|error| error.to_string())
}

#[tauri::command]
fn export_watermarked_images(
    input_root: String,
    images: Vec<WatermarkImageInput>,
    export_dir: String,
    source: WatermarkSource,
    config: WatermarkConfig,
) -> Result<WatermarkExportResponse, String> {
    export_watermarked_files(&input_root, &images, &export_dir, &source, &config)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn open_file_path(path: String) -> Result<(), String> {
    let file_path = PathBuf::from(path);
    if !file_path.exists() {
        return Err(format!("路径不存在: {}", file_path.display()));
    }

    Command::new("open")
        .arg(&file_path)
        .status()
        .map_err(|error| format!("启动系统打开命令失败: {error}"))
        .and_then(|status| {
            if status.success() {
                Ok(())
            } else {
                Err(format!("系统打开命令失败，退出码: {status}"))
            }
        })
}

#[tauri::command]
fn raw_thumbnail_path(path: String) -> Result<String, String> {
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

fn scan_watermark_directory(
    root: &str,
) -> Result<WatermarkScanResponse, Box<dyn std::error::Error>> {
    let root_path = PathBuf::from(root);
    if !root_path.is_dir() {
        return Err(format!("水印输入目录不存在或不是目录: {}", root_path.display()).into());
    }

    let mut images = Vec::new();
    let mut logs = Vec::new();
    let mut seen = HashSet::new();
    let mut skipped_count = 0;
    let mut duplicate_count = 0;

    for entry in WalkDir::new(&root_path)
        .into_iter()
        .filter_entry(|entry| !is_macos_metadata_dir(entry.path()))
    {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                skipped_count += 1;
                logs.push(format!("跳过无法访问的图片路径: {error}"));
                continue;
            }
        };

        if !entry.file_type().is_file() {
            continue;
        }

        let path = entry.path();
        if !is_watermark_image_path(path) {
            skipped_count += 1;
            continue;
        }

        let key = canonical_path_string(path);
        if !seen.insert(key) {
            duplicate_count += 1;
            continue;
        }

        match watermark_image_from_path(path, &root_path) {
            Ok(image) => images.push(image),
            Err(error) => {
                skipped_count += 1;
                logs.push(format!("跳过无法读取的图片 {}: {error}", path.display()));
            }
        }
    }

    images.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    if duplicate_count > 0 {
        logs.push(format!("已跳过 {duplicate_count} 个重复图片输入"));
    }
    if skipped_count > 0 {
        logs.push(format!(
            "已跳过 {skipped_count} 个不支持或无法访问的图片输入"
        ));
    }
    logs.push(format!("水印图片输入准备完成: {} 个文件", images.len()));

    Ok(WatermarkScanResponse {
        root_dir: canonical_path_string(&root_path),
        images,
        logs,
        skipped_count,
        duplicate_count,
    })
}

fn export_watermarked_files(
    input_root: &str,
    images: &[WatermarkImageInput],
    export_dir: &str,
    source: &WatermarkSource,
    config: &WatermarkConfig,
) -> Result<WatermarkExportResponse, Box<dyn std::error::Error>> {
    let input_root_path = PathBuf::from(input_root);
    if !input_root_path.is_dir() {
        return Err(format!(
            "水印输入目录不存在或不是目录: {}",
            input_root_path.display()
        )
        .into());
    }

    let export_path = PathBuf::from(export_dir);
    if !export_path.is_dir() {
        return Err(format!("水印导出目录不存在或不是目录: {}", export_path.display()).into());
    }

    let watermark = watermark_bitmap_from_source(source, config)?;
    if watermark.width() == 0 || watermark.height() == 0 {
        return Err("水印位图为空，无法导出".into());
    }

    let mut logs = Vec::new();
    let mut summary = WatermarkExportSummary::default();
    logs.push(format!("开始水印导出: {} 个图片", images.len()));

    for image_input in images {
        let source_path = PathBuf::from(&image_input.path);
        let relative_path = safe_relative_path(&image_input.relative_path, &source_path);
        let destination = export_path.join(relative_path);

        if destination.exists() {
            summary.collision_count += 1;
            summary.skipped_count += 1;
            logs.push(format!("跳过文件名冲突: {}", destination.display()));
            continue;
        }

        match process_watermark_export_item(&source_path, &destination, &watermark, config) {
            Ok(()) => {
                summary.exported_count += 1;
                logs.push(format!(
                    "已导出水印图片: {} -> {}",
                    image_input.file_name,
                    destination.display()
                ));
            }
            Err(error) => {
                summary.failed_count += 1;
                logs.push(format!("水印导出失败: {}: {error}", source_path.display()));
            }
        }
    }

    logs.push(format!(
        "水印导出完成: 成功 {}，跳过 {}，失败 {}，文件名冲突 {}",
        summary.exported_count,
        summary.skipped_count,
        summary.failed_count,
        summary.collision_count
    ));

    Ok(WatermarkExportResponse { logs, summary })
}

fn process_watermark_export_item(
    source_path: &Path,
    destination: &Path,
    watermark: &RgbaImage,
    config: &WatermarkConfig,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut target = image::open(source_path)?.to_rgba8();
    let prepared_watermark = prepare_watermark_for_target(watermark, target.width(), config)?;
    apply_watermark_layout(&mut target, &prepared_watermark, config);

    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
    }

    save_watermarked_image(destination, target)?;
    Ok(())
}

fn save_watermarked_image(
    destination: &Path,
    image: RgbaImage,
) -> Result<(), Box<dyn std::error::Error>> {
    if matches!(
        extension_lower(destination).as_deref(),
        Some("jpg" | "jpeg")
    ) {
        DynamicImage::ImageRgba8(image)
            .to_rgb8()
            .save(destination)?;
    } else {
        DynamicImage::ImageRgba8(image).save(destination)?;
    }
    Ok(())
}

fn create_text_watermark_bitmap(text: &str) -> Result<RgbaImage, Box<dyn std::error::Error>> {
    let lines = normalized_watermark_lines(text);
    let font = load_watermark_font(&lines.join("\n"))?;
    let scale = PxScale::from(WATERMARK_TEXT_FONT_SIZE);
    let line_height = WATERMARK_TEXT_FONT_SIZE * WATERMARK_TEXT_LINE_HEIGHT_RATIO;
    let measurements = lines
        .iter()
        .map(|line| text_size(scale, &font, line))
        .collect::<Vec<_>>();
    let text_width = measurements
        .iter()
        .map(|(width, _)| *width)
        .max()
        .unwrap_or(WATERMARK_TEXT_MIN_WIDTH)
        .max(WATERMARK_TEXT_MIN_WIDTH);
    let canvas_width = text_width + WATERMARK_TEXT_PADDING * 2;
    let canvas_height =
        ((lines.len() as f32 * line_height).ceil() as u32) + WATERMARK_TEXT_PADDING * 2;
    let mut bitmap = RgbaImage::from_pixel(canvas_width, canvas_height, Rgba([0, 0, 0, 0]));

    for (index, line) in lines.iter().enumerate() {
        let (line_width, line_height_px) = measurements[index];
        let x = ((canvas_width.saturating_sub(line_width)) / 2) as i32;
        let y = WATERMARK_TEXT_PADDING as f32
            + line_height * index as f32
            + ((line_height - line_height_px as f32) / 2.0).max(0.0);
        draw_text_mut(
            &mut bitmap,
            Rgba([255, 255, 255, 245]),
            x,
            y.round() as i32,
            scale,
            &font,
            line,
        );
    }

    Ok(bitmap)
}

fn normalized_watermark_lines(text: &str) -> Vec<String> {
    let lines = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    if lines.is_empty() {
        vec!["Watermark".to_string()]
    } else {
        lines
    }
}

fn load_watermark_font(text: &str) -> Result<FontArc, Box<dyn std::error::Error>> {
    let mut database = Database::new();
    database.load_system_fonts();

    for family in WATERMARK_TEXT_FONT_FAMILIES {
        let families = [Family::Name(*family)];
        for weight in [Weight::BOLD, Weight::SEMIBOLD, Weight::NORMAL] {
            if let Some(font) = font_from_query(&database, &families, weight) {
                if font_supports_text(&font, text) {
                    return Ok(font);
                }
            }
        }
    }

    let fallback_families = [Family::SansSerif];
    for weight in [Weight::BOLD, Weight::SEMIBOLD, Weight::NORMAL] {
        if let Some(font) = font_from_query(&database, &fallback_families, weight) {
            return Ok(font);
        }
    }

    Err("未找到可用于文字水印的系统字体".into())
}

fn font_from_query(
    database: &Database,
    families: &[Family<'_>],
    weight: Weight,
) -> Option<FontArc> {
    let id = database.query(&Query {
        families,
        weight,
        ..Query::default()
    })?;
    database
        .with_face_data(id, |data, face_index| {
            FontVec::try_from_vec_and_index(data.to_vec(), face_index).map(FontArc::new)
        })
        .and_then(Result::ok)
}

fn font_supports_text(font: &FontArc, text: &str) -> bool {
    text.chars()
        .filter(|character| !character.is_whitespace())
        .all(|character| font.glyph_id(character) != GlyphId(0))
}

fn watermark_bitmap_from_source(
    source: &WatermarkSource,
    config: &WatermarkConfig,
) -> Result<RgbaImage, Box<dyn std::error::Error>> {
    match source {
        WatermarkSource::Text { text } => create_text_watermark_bitmap(text),
        WatermarkSource::TextBitmap {
            width,
            height,
            pixels,
        } => {
            let expected_len = *width as usize * *height as usize * 4;
            if *width == 0 || *height == 0 || pixels.len() != expected_len {
                return Err("文字水印位图尺寸或像素数据无效".into());
            }
            ImageBuffer::from_raw(*width, *height, pixels.clone())
                .ok_or_else(|| "无法读取文字水印位图".into())
        }
        WatermarkSource::ImageFile { path } => {
            let mut watermark = image::open(path)?.to_rgba8();
            if config.auto_remove_background {
                remove_solid_background(
                    &mut watermark,
                    config.background_tolerance,
                    config.edge_feather,
                );
            }
            Ok(watermark)
        }
    }
}

fn prepare_watermark_for_target(
    watermark: &RgbaImage,
    target_width: u32,
    config: &WatermarkConfig,
) -> Result<RgbaImage, Box<dyn std::error::Error>> {
    let size_percent = config.size_percent.clamp(4.0, 80.0);
    let next_width = ((target_width as f32 * size_percent / 100.0).round() as u32).max(1);
    let ratio = watermark.height() as f32 / watermark.width().max(1) as f32;
    let next_height = ((next_width as f32 * ratio).round() as u32).max(1);
    let mut resized = resize_watermark_image(watermark, next_width, next_height)?;
    apply_overall_opacity(&mut resized, config.opacity);
    Ok(resized)
}

fn resize_watermark_image(
    watermark: &RgbaImage,
    width: u32,
    height: u32,
) -> Result<RgbaImage, Box<dyn std::error::Error>> {
    if watermark.width() == width && watermark.height() == height {
        return Ok(watermark.clone());
    }

    let mut resized = RgbaImage::new(width, height);
    let options = fr::ResizeOptions::new();
    let mut resizer = fr::Resizer::new();
    resizer.resize(watermark, &mut resized, Some(&options))?;
    Ok(resized)
}

fn apply_watermark_layout(target: &mut RgbaImage, watermark: &RgbaImage, config: &WatermarkConfig) {
    if watermark.width() == 0 || watermark.height() == 0 {
        return;
    }

    match config.layout {
        WatermarkLayout::Single => {
            let margin = ((target.width().min(target.height()) as f32) * 0.035)
                .round()
                .clamp(12.0, 48.0) as i64;
            let x = target.width() as i64 - watermark.width() as i64 - margin;
            let y = target.height() as i64 - watermark.height() as i64 - margin;
            overlay_watermark(
                target,
                watermark,
                x.max(0),
                y.max(0),
                config.shadow_strength,
            );
        }
        WatermarkLayout::Tile => {
            let gap_x = (watermark.width() / 2).max(32) as i64;
            let gap_y = (watermark.height() / 2).max(32) as i64;
            let step_x = watermark.width() as i64 + gap_x;
            let step_y = watermark.height() as i64 + gap_y;
            let mut y = gap_y / 2;
            while y < target.height() as i64 {
                let mut x = gap_x / 2;
                while x < target.width() as i64 {
                    overlay_watermark(target, watermark, x, y, config.shadow_strength);
                    x += step_x;
                }
                y += step_y;
            }
        }
    }
}

fn overlay_watermark(
    target: &mut RgbaImage,
    watermark: &RgbaImage,
    x: i64,
    y: i64,
    shadow_strength: f32,
) {
    if shadow_strength > 0.0 {
        let offset = (watermark.width().max(watermark.height()) as f32 * 0.035)
            .round()
            .clamp(2.0, 16.0) as i64;
        overlay_tinted_alpha(
            target,
            watermark,
            x + offset,
            y + offset,
            [0, 0, 0],
            shadow_strength * 0.45,
        );
    }

    overlay_rgba(target, watermark, x, y);
}

fn overlay_tinted_alpha(
    target: &mut RgbaImage,
    watermark: &RgbaImage,
    x: i64,
    y: i64,
    tint: [u8; 3],
    opacity_scale: f32,
) {
    let scale = opacity_scale.clamp(0.0, 1.0);
    let mut shadow = RgbaImage::new(watermark.width(), watermark.height());
    for (local_x, local_y, pixel) in watermark.enumerate_pixels() {
        let alpha = ((pixel[3] as f32) * scale).round().clamp(0.0, 255.0) as u8;
        if alpha == 0 {
            continue;
        }
        shadow.put_pixel(local_x, local_y, Rgba([tint[0], tint[1], tint[2], alpha]));
    }
    overlay_rgba(target, &shadow, x, y);
}

fn overlay_rgba(target: &mut RgbaImage, watermark: &RgbaImage, x: i64, y: i64) {
    if watermark.width() == 0
        || watermark.height() == 0
        || x >= target.width() as i64
        || y >= target.height() as i64
        || x + watermark.width() as i64 <= 0
        || y + watermark.height() as i64 <= 0
    {
        return;
    }

    let target_x = x.max(0) as u32;
    let target_y = y.max(0) as u32;
    let crop_x = if x < 0 { (-x) as u32 } else { 0 };
    let crop_y = if y < 0 { (-y) as u32 } else { 0 };
    let visible_width = (watermark.width() - crop_x).min(target.width() - target_x);
    let visible_height = (watermark.height() - crop_y).min(target.height() - target_y);
    if visible_width == 0 || visible_height == 0 {
        return;
    }

    let visible_watermark =
        image::imageops::crop_imm(watermark, crop_x, crop_y, visible_width, visible_height)
            .to_image();
    overlay_mut(target, &visible_watermark, target_x, target_y);
}

fn apply_overall_opacity(image: &mut RgbaImage, opacity: f32) {
    let opacity = opacity.clamp(0.0, 1.0);
    for pixel in image.pixels_mut() {
        pixel[3] = ((pixel[3] as f32) * opacity).round().clamp(0.0, 255.0) as u8;
    }
}

fn remove_solid_background(image: &mut RgbaImage, tolerance: f32, edge_feather: u32) {
    let background = estimate_background_color(image);
    let tolerance = tolerance.clamp(0.0, 255.0);
    let feather = edge_feather as f32;
    let soft_range = feather.max(1.0) * 6.0;

    for pixel in image.pixels_mut() {
        let distance = color_distance([pixel[0], pixel[1], pixel[2]], background);
        if distance <= tolerance {
            pixel[3] = 0;
        } else if feather > 0.0 && distance <= tolerance + soft_range {
            let factor = ((distance - tolerance) / soft_range).clamp(0.0, 1.0);
            pixel[3] = ((pixel[3] as f32) * factor).round().clamp(0.0, 255.0) as u8;
        }
    }
}

fn estimate_background_color(image: &RgbaImage) -> [u8; 3] {
    if image.width() == 0 || image.height() == 0 {
        return [255, 255, 255];
    }

    let mut red = 0_u64;
    let mut green = 0_u64;
    let mut blue = 0_u64;
    let mut count = 0_u64;
    let step_x = (image.width() / 16).max(1);
    let step_y = (image.height() / 16).max(1);

    for x in (0..image.width()).step_by(step_x as usize) {
        accumulate_rgb(
            image.get_pixel(x, 0),
            &mut red,
            &mut green,
            &mut blue,
            &mut count,
        );
        accumulate_rgb(
            image.get_pixel(x, image.height() - 1),
            &mut red,
            &mut green,
            &mut blue,
            &mut count,
        );
    }
    for y in (0..image.height()).step_by(step_y as usize) {
        accumulate_rgb(
            image.get_pixel(0, y),
            &mut red,
            &mut green,
            &mut blue,
            &mut count,
        );
        accumulate_rgb(
            image.get_pixel(image.width() - 1, y),
            &mut red,
            &mut green,
            &mut blue,
            &mut count,
        );
    }

    if count == 0 {
        return [255, 255, 255];
    }
    [
        (red / count) as u8,
        (green / count) as u8,
        (blue / count) as u8,
    ]
}

fn accumulate_rgb(
    pixel: &Rgba<u8>,
    red: &mut u64,
    green: &mut u64,
    blue: &mut u64,
    count: &mut u64,
) {
    *red += pixel[0] as u64;
    *green += pixel[1] as u64;
    *blue += pixel[2] as u64;
    *count += 1;
}

fn color_distance(left: [u8; 3], right: [u8; 3]) -> f32 {
    let red = left[0] as f32 - right[0] as f32;
    let green = left[1] as f32 - right[1] as f32;
    let blue = left[2] as f32 - right[2] as f32;
    (red * red + green * green + blue * blue).sqrt()
}

fn watermark_image_from_path(
    path: &Path,
    root: &Path,
) -> Result<WatermarkImageInput, Box<dyn std::error::Error>> {
    let metadata = fs::metadata(path)?;
    let relative_path = path
        .strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .to_string();
    Ok(WatermarkImageInput {
        path: canonical_path_string(path),
        file_name: file_name(path)?,
        relative_path,
        size: metadata.len(),
        modified_time: modified_seconds(&metadata),
    })
}

fn safe_relative_path(relative_path: &str, source_path: &Path) -> PathBuf {
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

fn files_have_same_contents(left: &Path, right: &Path) -> Result<bool, Box<dyn std::error::Error>> {
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
struct RawScan {
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

fn is_watermark_image_path(path: &Path) -> bool {
    extension_lower(path)
        .map(|extension| WATERMARK_IMAGE_EXTENSIONS.contains(&extension.as_str()))
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
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            collect_jpeg_inputs,
            match_raw_files,
            export_raw_files,
            scan_watermark_images,
            export_watermarked_images,
            open_file_path,
            raw_thumbnail_path
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

    #[test]
    fn scans_nested_watermark_images_and_skips_unsupported_files() {
        let temp = tempdir().unwrap();
        let input_root = temp.path().join("input");
        let nested = input_root.join("album/day1");
        fs::create_dir_all(&nested).unwrap();
        write_test_image(&nested.join("cover.png"), Rgba([240, 240, 240, 255]));
        write_test_image(&input_root.join("hero.JPG"), Rgba([180, 190, 200, 255]));
        write_file(&input_root.join("notes.txt"), b"notes");

        let response = scan_watermark_directory(&input_root.to_string_lossy()).unwrap();

        assert_eq!(response.images.len(), 2);
        assert_eq!(response.skipped_count, 1);
        assert!(response
            .images
            .iter()
            .any(|image| image.relative_path == "album/day1/cover.png"));
        assert!(response
            .logs
            .iter()
            .any(|log| log.contains("水印图片输入准备完成")));
    }

    #[test]
    fn removes_solid_background_with_tolerance() {
        let mut image = RgbaImage::from_pixel(5, 5, Rgba([255, 255, 255, 255]));
        image.put_pixel(2, 2, Rgba([0, 128, 200, 255]));

        remove_solid_background(&mut image, 12.0, 0);

        assert_eq!(image.get_pixel(0, 0)[3], 0);
        assert_eq!(image.get_pixel(4, 4)[3], 0);
        assert_eq!(image.get_pixel(2, 2)[3], 255);
    }

    #[test]
    fn renders_text_watermark_bitmap_with_visible_pixels() {
        let image = create_text_watermark_bitmap("Watermark").unwrap();

        assert!(image.width() >= WATERMARK_TEXT_MIN_WIDTH);
        assert!(image.pixels().any(|pixel| pixel[3] > 0));
    }

    #[test]
    fn watermark_export_skips_existing_files_and_counts_summary() {
        let temp = tempdir().unwrap();
        let input_root = temp.path().join("input");
        let export_root = temp.path().join("export");
        fs::create_dir_all(&input_root).unwrap();
        fs::create_dir_all(&export_root).unwrap();
        let source_path = input_root.join("photo.png");
        write_test_image(&source_path, Rgba([120, 150, 180, 255]));
        write_test_image(&export_root.join("photo.png"), Rgba([20, 20, 20, 255]));

        let image_input = watermark_image_from_path(&source_path, &input_root).unwrap();
        let response = export_watermarked_files(
            &input_root.to_string_lossy(),
            &[image_input],
            &export_root.to_string_lossy(),
            &test_watermark_source(),
            &test_watermark_config(),
        )
        .unwrap();

        assert_eq!(response.summary.exported_count, 0);
        assert_eq!(response.summary.skipped_count, 1);
        assert_eq!(response.summary.collision_count, 1);
        assert!(response.logs.iter().any(|log| log.contains("文件名冲突")));
    }

    #[test]
    fn watermark_export_preserves_relative_directory_structure() {
        let temp = tempdir().unwrap();
        let input_root = temp.path().join("input");
        let nested = input_root.join("album/day1");
        let export_root = temp.path().join("export");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir_all(&export_root).unwrap();
        let source_path = nested.join("photo.png");
        write_test_image(&source_path, Rgba([120, 150, 180, 255]));

        let image_input = watermark_image_from_path(&source_path, &input_root).unwrap();
        let response = export_watermarked_files(
            &input_root.to_string_lossy(),
            &[image_input],
            &export_root.to_string_lossy(),
            &test_watermark_source(),
            &test_watermark_config(),
        )
        .unwrap();

        assert_eq!(response.summary.exported_count, 1);
        assert!(export_root.join("album/day1/photo.png").is_file());
        assert!(source_path.is_file());
    }

    fn test_watermark_config() -> WatermarkConfig {
        WatermarkConfig {
            opacity: 1.0,
            size_percent: 20.0,
            auto_remove_background: false,
            background_tolerance: 32.0,
            edge_feather: 0,
            shadow_strength: 0.0,
            layout: WatermarkLayout::Single,
        }
    }

    fn test_watermark_source() -> WatermarkSource {
        WatermarkSource::TextBitmap {
            width: 2,
            height: 2,
            pixels: vec![
                255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255,
            ],
        }
    }

    fn write_file(path: &Path, bytes: &[u8]) {
        let mut file = fs::File::create(path).unwrap();
        file.write_all(bytes).unwrap();
    }

    fn write_test_image(path: &Path, color: Rgba<u8>) {
        let image = RgbaImage::from_pixel(12, 8, color);
        DynamicImage::ImageRgba8(image).save(path).unwrap();
    }

    fn write_raw_file(path: &Path) {
        write_sized_file(path, MIN_RAW_FILE_SIZE_BYTES + 1);
    }

    fn write_sized_file(path: &Path, size: u64) {
        let file = fs::File::create(path).unwrap();
        file.set_len(size).unwrap();
    }
}
