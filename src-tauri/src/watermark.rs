use crate::shared::{extension_lower, file_name, is_macos_metadata_dir, modified_seconds};
use ab_glyph::{Font, FontVec, PxScale};
use image::{
    codecs::{jpeg::JpegEncoder, png::PngEncoder},
    imageops::{resize, FilterType},
    metadata::Orientation,
    DynamicImage, ExtendedColorType, GenericImageView, ImageDecoder, ImageEncoder, ImageFormat,
    ImageReader, Rgba, RgbaImage,
};
use imageproc::drawing::{draw_text_mut, text_size};
use imageproc::geometric_transformations::{rotate_about_center_no_crop, Border, Interpolation};
use serde::{Deserialize, Serialize};
use std::{
    collections::{hash_map::DefaultHasher, HashSet, VecDeque},
    env, fs,
    fs::OpenOptions,
    hash::{Hash, Hasher},
    io,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
};
use tauri::{ipc::Channel, State};
use walkdir::WalkDir;

const SUPPORTED_EXTENSIONS: [&str; 3] = ["jpg", "jpeg", "png"];
const DEFAULT_PREVIEW_EDGE: u32 = 1_400;
const WATERMARK_PREVIEW_EDGE: u32 = 1_024;
const MIN_PREVIEW_EDGE: u32 = 64;
const MAX_PREVIEW_EDGE: u32 = 2_048;
const MIN_JPEG_QUALITY: u8 = 1;
const MAX_JPEG_QUALITY: u8 = 100;
const SAFE_MARGIN_PERCENT: f32 = 3.0;
const BACKGROUND_TOLERANCE: u8 = 32;
const BACKGROUND_FEATHER: u8 = 20;
const BACKGROUND_COLOR_BUCKETS: usize = 16 * 16 * 16;
const BORDER_TRIM_DIVISOR: u32 = 96;
const GLASS_EDGE_RADIUS_DIVISOR: u32 = 200;
const MAX_GLASS_EDGE_RADIUS: u32 = 4;
const GLASS_FILL_ALPHA: u8 = 64;
const GLASS_HIGHLIGHT_ALPHA: u8 = 220;
const GLASS_DARK_RIM_ALPHA: u8 = 104;
const INTERNAL_EDGE_TOLERANCE: u8 = 28;
const INTERNAL_EDGE_FEATHER: u8 = 96;
const MIN_GLASS_ALPHA_FACTOR: f32 = 0.35;
const TEXT_GLASS_ALPHA_COMPENSATION: f32 = 1.35;
const TEXT_GLASS_MAX_ALPHA: u8 = 240;
const MAX_TILE_COUNT: usize = 5_000;
const MAX_TEXT_WATERMARK_CHARACTERS: usize = 120;
const TEXT_RENDER_SCALE: f32 = 256.0;
const TEXT_RENDER_PADDING: u32 = 24;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AspectKind {
    Landscape,
    Portrait,
    Square,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WatermarkAnchor {
    TopLeft,
    TopCenter,
    TopRight,
    CenterLeft,
    Center,
    CenterRight,
    BottomLeft,
    BottomCenter,
    BottomRight,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WatermarkLayout {
    Single,
    Tile,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WatermarkSourceKind {
    Image,
    Text,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WatermarkSizeBasis {
    Width,
    Height,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum WatermarkSource {
    Image { path: String },
    Text { text: String, font_id: String },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WatermarkProfile {
    layout: WatermarkLayout,
    anchor: WatermarkAnchor,
    clarity: f32,
    size_percent: f32,
    rotation_degrees: f32,
    offset_x_percent: f32,
    offset_y_percent: f32,
    tile_spacing_percent: f32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WatermarkProfiles {
    landscape: WatermarkProfile,
    portrait: WatermarkProfile,
    square: WatermarkProfile,
}

impl WatermarkProfiles {
    fn profile_for(self, aspect: AspectKind) -> WatermarkProfile {
        match aspect {
            AspectKind::Landscape => self.landscape,
            AspectKind::Portrait => self.portrait,
            AspectKind::Square => self.square,
        }
    }

    fn validate(self) -> Result<(), String> {
        for (label, profile) in [
            ("横图", self.landscape),
            ("竖图", self.portrait),
            ("方图", self.square),
        ] {
            profile.validate(label)?;
        }
        Ok(())
    }
}

impl WatermarkProfile {
    fn validate(self, label: &str) -> Result<(), String> {
        validate_number(label, "通透度", self.clarity, 0.0, 1.0)?;
        validate_number(label, "尺寸", self.size_percent, 1.0, 100.0)?;
        validate_number(label, "旋转", self.rotation_degrees, -180.0, 180.0)?;
        validate_number(label, "横向偏移", self.offset_x_percent, -50.0, 50.0)?;
        validate_number(label, "纵向偏移", self.offset_y_percent, -50.0, 50.0)?;
        validate_number(label, "平铺间距", self.tile_spacing_percent, 1.0, 50.0)?;
        Ok(())
    }
}

fn validate_number(
    profile_label: &str,
    field_label: &str,
    value: f32,
    minimum: f32,
    maximum: f32,
) -> Result<(), String> {
    if !value.is_finite() || value < minimum || value > maximum {
        return Err(format!(
            "{profile_label}{field_label}超出允许范围 {minimum}–{maximum}: {value}"
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WatermarkImageInput {
    path: String,
    file_name: String,
    relative_path: String,
    width: u32,
    height: u32,
    aspect: AspectKind,
    size: u64,
    modified_time: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WatermarkScanResponse {
    root_dir: String,
    images: Vec<WatermarkImageInput>,
    skipped_count: u32,
    logs: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WatermarkAssetInfo {
    path: String,
    file_name: String,
    source_kind: WatermarkSourceKind,
    size_basis: WatermarkSizeBasis,
    width: u32,
    height: u32,
    has_transparency: bool,
    source_has_transparency: bool,
    glass_processed: bool,
    preview_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WatermarkFontInfo {
    id: String,
    display_name: String,
    family_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WatermarkFontCatalog {
    fonts: Vec<WatermarkFontInfo>,
    default_font_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TextWatermarkRequest {
    text: String,
    font_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WatermarkPreviewAsset {
    path: String,
    width: u32,
    height: u32,
    preview_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WatermarkExportRequest {
    job_id: String,
    input_root: String,
    export_dir: String,
    jpeg_quality: u8,
    source: WatermarkSource,
    image_paths: Vec<String>,
    profiles: WatermarkProfiles,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WatermarkItemStatus {
    Exported,
    Skipped,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum WatermarkExportEvent {
    Started {
        job_id: String,
        total_count: u32,
    },
    ItemFinished {
        job_id: String,
        index: u32,
        total_count: u32,
        relative_path: String,
        status: WatermarkItemStatus,
        message: String,
    },
    Warning {
        job_id: String,
        relative_path: String,
        message: String,
    },
    Cancelled {
        job_id: String,
        processed_count: u32,
        remaining_count: u32,
    },
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WatermarkExportSummary {
    total_count: u32,
    processed_count: u32,
    exported_count: u32,
    skipped_existing_count: u32,
    failed_count: u32,
    cancelled_remaining_count: u32,
}

#[derive(Debug)]
struct ActiveWatermarkJob {
    job_id: String,
    cancelled: Arc<AtomicBool>,
}

#[derive(Debug, Default)]
pub(crate) struct WatermarkJobState {
    active: Mutex<Option<ActiveWatermarkJob>>,
}

struct WatermarkFontStore {
    database: fontdb::Database,
    catalog: WatermarkFontCatalog,
}

static WATERMARK_FONT_STORE: OnceLock<Result<WatermarkFontStore, String>> = OnceLock::new();

impl WatermarkJobState {
    fn begin(&self, job_id: &str) -> Result<Arc<AtomicBool>, String> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| "水印任务状态已损坏".to_string())?;
        if let Some(current) = active.as_ref() {
            return Err(format!("已有水印导出任务正在运行: {}", current.job_id));
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        *active = Some(ActiveWatermarkJob {
            job_id: job_id.to_string(),
            cancelled: Arc::clone(&cancelled),
        });
        Ok(cancelled)
    }

    fn cancel(&self, job_id: &str) -> Result<bool, String> {
        let active = self
            .active
            .lock()
            .map_err(|_| "水印任务状态已损坏".to_string())?;
        let Some(current) = active.as_ref() else {
            return Ok(false);
        };
        if current.job_id != job_id {
            return Err("任务标识与当前水印导出任务不一致".to_string());
        }
        current.cancelled.store(true, Ordering::Release);
        Ok(true)
    }

    fn finish(&self, job_id: &str) {
        if let Ok(mut active) = self.active.lock() {
            if active
                .as_ref()
                .is_some_and(|current| current.job_id == job_id)
            {
                *active = None;
            }
        }
    }
}

#[tauri::command]
pub(crate) async fn scan_watermark_source(root: String) -> Result<WatermarkScanResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        scan_watermark_directory(Path::new(&root)).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("图片扫描任务异常结束: {error}"))?
}

#[tauri::command]
pub(crate) async fn inspect_watermark_asset(path: String) -> Result<WatermarkAssetInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        inspect_watermark_file(Path::new(&path)).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("水印素材检查任务异常结束: {error}"))?
}

#[tauri::command]
pub(crate) async fn list_watermark_fonts() -> Result<WatermarkFontCatalog, String> {
    tauri::async_runtime::spawn_blocking(|| font_store().map(|store| store.catalog.clone()))
        .await
        .map_err(|error| format!("本机字体目录任务异常结束: {error}"))?
}

#[tauri::command]
pub(crate) async fn inspect_text_watermark(
    request: TextWatermarkRequest,
) -> Result<WatermarkAssetInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        inspect_text_watermark_request(&request).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("文字水印生成任务异常结束: {error}"))?
}

#[tauri::command]
pub(crate) async fn watermark_preview_asset(
    input_root: String,
    path: String,
    max_edge: Option<u32>,
) -> Result<WatermarkPreviewAsset, String> {
    tauri::async_runtime::spawn_blocking(move || {
        prepare_photo_preview(
            Path::new(&input_root),
            Path::new(&path),
            max_edge.unwrap_or(DEFAULT_PREVIEW_EDGE),
        )
        .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("图片预览任务异常结束: {error}"))?
}

#[tauri::command]
pub(crate) async fn export_watermarked_images(
    request: WatermarkExportRequest,
    on_event: Channel<WatermarkExportEvent>,
    state: State<'_, WatermarkJobState>,
) -> Result<WatermarkExportSummary, String> {
    validate_job_id(&request.job_id)?;
    let job_id = request.job_id.clone();
    let cancelled = state.begin(&job_id)?;
    let worker_job_id = job_id.clone();
    let worker_result = tauri::async_runtime::spawn_blocking(move || {
        let prepared = prepare_export(request)?;
        export_prepared(prepared, cancelled, |event| {
            let _ = on_event.send(event);
        })
    })
    .await;
    state.finish(&worker_job_id);
    worker_result.map_err(|error| format!("水印导出任务异常退出: {error}"))?
}

#[tauri::command]
pub(crate) fn cancel_watermark_export(
    job_id: String,
    state: State<'_, WatermarkJobState>,
) -> Result<bool, String> {
    validate_job_id(&job_id)?;
    state.cancel(&job_id)
}

fn validate_job_id(job_id: &str) -> Result<(), String> {
    if job_id.is_empty() || job_id.len() > 128 {
        return Err("水印任务标识为空或过长".to_string());
    }
    Ok(())
}

fn scan_watermark_directory(
    requested_root: &Path,
) -> Result<WatermarkScanResponse, Box<dyn std::error::Error>> {
    let root = canonical_directory(requested_root, "图片输入目录")?;
    let mut images = Vec::new();
    let mut skipped_count = 0_u32;
    let mut logs = vec![format!("开始扫描图片目录: {}", root.display())];

    for entry in WalkDir::new(&root)
        .follow_links(false)
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
        if entry.path() == root {
            continue;
        }
        if entry.file_type().is_symlink() {
            skipped_count += 1;
            logs.push(format!("跳过符号链接: {}", entry.path().display()));
            continue;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        if !is_supported_image(entry.path()) {
            skipped_count += 1;
            continue;
        }

        match watermark_input_from_path(&root, entry.path()) {
            Ok(image) => images.push(image),
            Err(error) => {
                skipped_count += 1;
                logs.push(format!(
                    "跳过无法读取的图片 {}: {error}",
                    entry.path().display()
                ));
            }
        }
    }

    images.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    logs.push(format!(
        "扫描完成: 识别 {} 张图片，跳过 {} 个项目",
        images.len(),
        skipped_count
    ));
    Ok(WatermarkScanResponse {
        root_dir: root.to_string_lossy().to_string(),
        images,
        skipped_count,
        logs,
    })
}

fn watermark_input_from_path(
    root: &Path,
    path: &Path,
) -> Result<WatermarkImageInput, Box<dyn std::error::Error>> {
    let metadata = fs::metadata(path)?;
    let relative = path.strip_prefix(root)?;
    let (width, height, aspect) = oriented_dimensions(path)?;
    Ok(WatermarkImageInput {
        path: path.to_string_lossy().to_string(),
        file_name: file_name(path)?,
        relative_path: relative.to_string_lossy().to_string(),
        width,
        height,
        aspect,
        size: metadata.len(),
        modified_time: modified_seconds(&metadata),
    })
}

fn oriented_dimensions(path: &Path) -> Result<(u32, u32, AspectKind), Box<dyn std::error::Error>> {
    let mut decoder = ImageReader::open(path)?
        .with_guessed_format()?
        .into_decoder()?;
    let (mut width, mut height) = decoder.dimensions();
    let orientation = decoder.orientation()?;
    if orientation_swaps_dimensions(orientation) {
        std::mem::swap(&mut width, &mut height);
    }
    Ok((width, height, aspect_for_dimensions(width, height)))
}

fn orientation_swaps_dimensions(orientation: Orientation) -> bool {
    matches!(
        orientation,
        Orientation::Rotate90
            | Orientation::Rotate270
            | Orientation::Rotate90FlipH
            | Orientation::Rotate270FlipH
    )
}

fn aspect_for_dimensions(width: u32, height: u32) -> AspectKind {
    if width == height {
        AspectKind::Square
    } else if width > height {
        AspectKind::Landscape
    } else {
        AspectKind::Portrait
    }
}

fn font_store() -> Result<&'static WatermarkFontStore, String> {
    match WATERMARK_FONT_STORE.get_or_init(load_font_store) {
        Ok(store) => Ok(store),
        Err(error) => Err(error.clone()),
    }
}

fn load_font_store() -> Result<WatermarkFontStore, String> {
    let mut database = fontdb::Database::new();
    database.load_system_fonts();
    let mut seen = HashSet::new();
    let mut fonts = database
        .faces()
        .filter_map(|face| {
            let id = face.post_script_name.trim();
            if id.is_empty() || !seen.insert(id.to_string()) {
                return None;
            }
            let family_name = face
                .families
                .first()
                .map(|family| family.0.trim())
                .filter(|family| !family.is_empty())
                .unwrap_or(id)
                .to_string();
            let display_name = if family_name == id {
                family_name.clone()
            } else {
                format!("{family_name} — {id}")
            };
            Some(WatermarkFontInfo {
                id: id.to_string(),
                display_name,
                family_name,
            })
        })
        .collect::<Vec<_>>();
    fonts.sort_by(|left, right| {
        left.display_name
            .to_lowercase()
            .cmp(&right.display_name.to_lowercase())
            .then_with(|| left.id.cmp(&right.id))
    });
    if fonts.is_empty() {
        return Err("未发现可用的 macOS 本机字体".to_string());
    }
    let preferred_ids = [
        "PingFangSC-Regular",
        "PingFang-SC-Regular",
        "Helvetica",
        "HelveticaNeue",
        "ArialMT",
    ];
    let default_font_id = preferred_ids
        .iter()
        .find_map(|preferred| {
            fonts
                .iter()
                .find(|font| font.id.eq_ignore_ascii_case(preferred))
                .map(|font| font.id.clone())
        })
        .or_else(|| {
            fonts
                .iter()
                .find(|font| font.family_name.contains("PingFang"))
                .map(|font| font.id.clone())
        })
        .unwrap_or_else(|| fonts[0].id.clone());
    Ok(WatermarkFontStore {
        database,
        catalog: WatermarkFontCatalog {
            fonts,
            default_font_id,
        },
    })
}

fn load_watermark_font(font_id: &str) -> Result<FontVec, String> {
    let store = font_store()?;
    let face = store
        .database
        .faces()
        .find(|face| face.post_script_name == font_id)
        .ok_or_else(|| format!("所选本机字体已失效: {font_id}"))?;
    store
        .database
        .with_face_data(face.id, |data, index| {
            FontVec::try_from_vec_and_index(data.to_vec(), index)
        })
        .ok_or_else(|| format!("无法读取本机字体数据: {font_id}"))?
        .map_err(|_| format!("无法解析本机字体: {font_id}"))
}

fn validate_text_watermark(text: &str) -> Result<String, String> {
    let trimmed = text.trim();
    let count = trimmed.chars().count();
    if count == 0 {
        return Err("请输入文字水印内容".to_string());
    }
    if count > MAX_TEXT_WATERMARK_CHARACTERS {
        return Err(format!(
            "文字水印最多支持 {MAX_TEXT_WATERMARK_CHARACTERS} 个字符"
        ));
    }
    if trimmed.chars().any(char::is_control) {
        return Err("文字水印仅支持单行文字，不能包含换行或控制字符".to_string());
    }
    Ok(trimmed.to_string())
}

fn render_text_watermark_mask(text: &str, font: &FontVec) -> Result<RgbaImage, String> {
    if !text
        .chars()
        .filter(|character| !character.is_whitespace())
        .any(|character| font.glyph_id(character).0 != 0)
    {
        return Err("所选字体无法生成当前文字，请更换字体".to_string());
    }
    let scale = PxScale::from(TEXT_RENDER_SCALE);
    let (text_width, text_height) = text_size(scale, font, text);
    let width = text_width
        .checked_add(TEXT_RENDER_PADDING.saturating_mul(2))
        .ok_or_else(|| "文字水印尺寸过大".to_string())?;
    let height = text_height
        .checked_add(TEXT_RENDER_PADDING.saturating_mul(2))
        .ok_or_else(|| "文字水印尺寸过大".to_string())?;
    if width == 0 || height == 0 || width > 32_768 || height > 4_096 {
        return Err("文字水印尺寸过大，请缩短文字内容".to_string());
    }
    let mut mask = RgbaImage::from_pixel(width, height, Rgba([0, 0, 0, 0]));
    draw_text_mut(
        &mut mask,
        Rgba([255, 255, 255, 255]),
        TEXT_RENDER_PADDING as i32,
        TEXT_RENDER_PADDING as i32,
        scale,
        font,
        text,
    );
    if !mask.pixels().any(|pixel| pixel[3] >= 32) {
        return Err("所选字体无法生成当前文字，请更换字体".to_string());
    }
    Ok(mask)
}

fn inspect_text_watermark_request(
    request: &TextWatermarkRequest,
) -> Result<WatermarkAssetInfo, Box<dyn std::error::Error>> {
    let text = validate_text_watermark(&request.text)?;
    let prepared = prepare_text_watermark_asset(&text, &request.font_id)?;
    let (width, height) = prepared.image.dimensions();
    let cache_key = format!("{}\0{text}", request.font_id);
    let preview_path = write_generated_preview_cache(
        &cache_key,
        "watermark-text-glass-v2",
        WATERMARK_PREVIEW_EDGE,
        DynamicImage::ImageRgba8(prepared.image),
    )?;
    Ok(WatermarkAssetInfo {
        path: String::new(),
        file_name: text,
        source_kind: WatermarkSourceKind::Text,
        size_basis: WatermarkSizeBasis::Height,
        width,
        height,
        has_transparency: true,
        source_has_transparency: true,
        glass_processed: true,
        preview_path: preview_path.to_string_lossy().to_string(),
    })
}

fn inspect_watermark_file(
    requested_path: &Path,
) -> Result<WatermarkAssetInfo, Box<dyn std::error::Error>> {
    let path = canonical_supported_file(requested_path, "水印图片")?;
    let prepared = prepare_watermark_asset(&path)?;
    let (width, height) = prepared.image.dimensions();
    if width == 0 || height == 0 {
        return Err("水印图片尺寸无效".into());
    }
    let preview_path = write_preview_cache(
        &path,
        "watermark-glass-v1",
        WATERMARK_PREVIEW_EDGE,
        DynamicImage::ImageRgba8(prepared.image),
    )?;
    Ok(WatermarkAssetInfo {
        path: path.to_string_lossy().to_string(),
        file_name: file_name(&path)?,
        source_kind: WatermarkSourceKind::Image,
        size_basis: WatermarkSizeBasis::Width,
        width,
        height,
        has_transparency: true,
        source_has_transparency: prepared.source_has_transparency,
        glass_processed: prepared.glass_processed,
        preview_path: preview_path.to_string_lossy().to_string(),
    })
}

struct PreparedWatermarkAsset {
    image: RgbaImage,
    source_has_transparency: bool,
    glass_processed: bool,
    size_basis: WatermarkSizeBasis,
}

fn prepare_watermark_asset(
    path: &Path,
) -> Result<PreparedWatermarkAsset, Box<dyn std::error::Error>> {
    let decoded = decode_oriented_image(path)?;
    let source = decoded.image.to_rgba8();
    if source.width() == 0 || source.height() == 0 {
        return Err("水印图片尺寸无效".into());
    }
    let source_has_transparency = source.pixels().any(|pixel| pixel[3] < u8::MAX);
    let image = create_glass_watermark(&source, source_has_transparency)?;
    Ok(PreparedWatermarkAsset {
        image,
        source_has_transparency,
        glass_processed: true,
        size_basis: WatermarkSizeBasis::Width,
    })
}

fn prepare_text_watermark_asset(
    text: &str,
    font_id: &str,
) -> Result<PreparedWatermarkAsset, Box<dyn std::error::Error>> {
    let text = validate_text_watermark(text)?;
    let font = load_watermark_font(font_id)?;
    let mask = render_text_watermark_mask(&text, &font)?;
    let mut image = create_glass_watermark(&mask, true)?;
    calibrate_text_glass_visibility(&mut image);
    Ok(PreparedWatermarkAsset {
        image,
        source_has_transparency: true,
        glass_processed: true,
        size_basis: WatermarkSizeBasis::Height,
    })
}

fn prepare_watermark_source(
    source: &WatermarkSource,
) -> Result<PreparedWatermarkAsset, Box<dyn std::error::Error>> {
    match source {
        WatermarkSource::Image { path } => prepare_watermark_asset(Path::new(path)),
        WatermarkSource::Text { text, font_id } => prepare_text_watermark_asset(text, font_id),
    }
}

fn create_glass_watermark(
    source: &RgbaImage,
    source_has_transparency: bool,
) -> Result<RgbaImage, Box<dyn std::error::Error>> {
    let (width, height) = source.dimensions();
    if width == 0 || height == 0 {
        return Err("水印图片尺寸无效".into());
    }
    let pixel_count = width as usize * height as usize;
    let mask = glass_subject_mask(source, source_has_transparency);
    let foreground = mask.iter().map(|alpha| *alpha >= 32).collect::<Vec<_>>();
    if !foreground.iter().any(|value| *value) {
        return Err("水印素材没有可保留的主体，请改用包含有效主体的图片".into());
    }

    let mut distances = vec![u16::MAX; pixel_count];
    let mut queue = VecDeque::new();
    for y in 0..height {
        for x in 0..width {
            let index = pixel_index(width, x, y);
            if !foreground[index] {
                continue;
            }
            let touches_background = x == 0
                || x + 1 == width
                || y == 0
                || y + 1 == height
                || !foreground[pixel_index(width, x - 1, y)]
                || !foreground[pixel_index(width, x + 1, y)]
                || !foreground[pixel_index(width, x, y - 1)]
                || !foreground[pixel_index(width, x, y + 1)];
            if touches_background {
                distances[index] = 0;
                queue.push_back((x, y));
            }
        }
    }
    if queue.is_empty() {
        return Err("水印素材没有可保留的主体，请改用包含有效主体的图片".into());
    }

    let edge_radius = height
        .min(width)
        .div_ceil(GLASS_EDGE_RADIUS_DIVISOR)
        .clamp(1, MAX_GLASS_EDGE_RADIUS) as u16;
    while let Some((x, y)) = queue.pop_front() {
        let next_distance = distances[pixel_index(width, x, y)].saturating_add(1);
        if next_distance > edge_radius {
            continue;
        }
        if x > 0 {
            enqueue_glass_edge_pixel(
                width,
                &foreground,
                x - 1,
                y,
                next_distance,
                &mut distances,
                &mut queue,
            );
        }
        if x + 1 < width {
            enqueue_glass_edge_pixel(
                width,
                &foreground,
                x + 1,
                y,
                next_distance,
                &mut distances,
                &mut queue,
            );
        }
        if y > 0 {
            enqueue_glass_edge_pixel(
                width,
                &foreground,
                x,
                y - 1,
                next_distance,
                &mut distances,
                &mut queue,
            );
        }
        if y + 1 < height {
            enqueue_glass_edge_pixel(
                width,
                &foreground,
                x,
                y + 1,
                next_distance,
                &mut distances,
                &mut queue,
            );
        }
    }

    let mut output = RgbaImage::from_pixel(width, height, Rgba([0, 0, 0, 0]));
    for y in 0..height {
        for x in 0..width {
            let index = pixel_index(width, x, y);
            if !foreground[index] {
                continue;
            }
            let distance = distances[index];
            let (internal_contrast, pixel_is_lighter) =
                strongest_internal_edge(source, &foreground, x, y);
            let internal_alpha = if internal_contrast <= INTERNAL_EDGE_TOLERANCE {
                0
            } else {
                let strength = internal_contrast.saturating_sub(INTERNAL_EDGE_TOLERANCE) as f32
                    / INTERNAL_EDGE_FEATHER as f32;
                (strength.clamp(0.0, 1.0) * GLASS_HIGHLIGHT_ALPHA as f32).round() as u8
            };
            let (rgb, material_alpha) = if distance == 0 {
                ([248, 252, 255], GLASS_HIGHLIGHT_ALPHA)
            } else if distance <= edge_radius {
                ([32, 42, 52], GLASS_DARK_RIM_ALPHA)
            } else if internal_alpha > GLASS_FILL_ALPHA {
                if pixel_is_lighter {
                    ([248, 252, 255], internal_alpha)
                } else {
                    ([32, 42, 52], internal_alpha.min(GLASS_DARK_RIM_ALPHA))
                }
            } else {
                ([244, 249, 255], GLASS_FILL_ALPHA)
            };
            let alpha = (material_alpha as u16 * mask[index] as u16 / u8::MAX as u16) as u8;
            *output.get_pixel_mut(x, y) = Rgba([rgb[0], rgb[1], rgb[2], alpha]);
        }
    }
    Ok(output)
}

fn glass_subject_mask(source: &RgbaImage, source_has_transparency: bool) -> Vec<u8> {
    if source_has_transparency {
        return source.pixels().map(|pixel| pixel[3]).collect();
    }
    let background = dominant_color(source);
    let border_trim = source
        .width()
        .min(source.height())
        .div_ceil(BORDER_TRIM_DIVISOR)
        .max(1);
    source
        .enumerate_pixels()
        .map(|(x, y, pixel)| {
            if x < border_trim
                || y < border_trim
                || x + border_trim >= source.width()
                || y + border_trim >= source.height()
            {
                return 0;
            }
            let distance = color_distance(pixel, background);
            if distance <= BACKGROUND_TOLERANCE {
                0
            } else {
                let foreground_distance = distance.saturating_sub(BACKGROUND_TOLERANCE) as f32;
                (foreground_distance / BACKGROUND_FEATHER.max(1) as f32 * u8::MAX as f32)
                    .round()
                    .clamp(0.0, u8::MAX as f32) as u8
            }
        })
        .collect()
}

fn enqueue_glass_edge_pixel(
    width: u32,
    foreground: &[bool],
    x: u32,
    y: u32,
    distance: u16,
    distances: &mut [u16],
    queue: &mut VecDeque<(u32, u32)>,
) {
    let index = pixel_index(width, x, y);
    if !foreground[index] || distances[index] <= distance {
        return;
    }
    distances[index] = distance;
    queue.push_back((x, y));
}

fn strongest_internal_edge(source: &RgbaImage, foreground: &[bool], x: u32, y: u32) -> (u8, bool) {
    let width = source.width();
    let height = source.height();
    let current = source.get_pixel(x, y);
    let mut strongest = 0_u8;
    let mut current_is_lighter = true;
    for (neighbor_x, neighbor_y) in [
        x.checked_sub(1).map(|value| (value, y)),
        (x + 1 < width).then_some((x + 1, y)),
        y.checked_sub(1).map(|value| (x, value)),
        (y + 1 < height).then_some((x, y + 1)),
    ]
    .into_iter()
    .flatten()
    {
        if !foreground[pixel_index(width, neighbor_x, neighbor_y)] {
            continue;
        }
        let neighbor = source.get_pixel(neighbor_x, neighbor_y);
        let contrast = color_distance_between(current, neighbor);
        if contrast > strongest {
            strongest = contrast;
            current_is_lighter = pixel_luminance(current) >= pixel_luminance(neighbor);
        }
    }
    (strongest, current_is_lighter)
}

fn pixel_index(width: u32, x: u32, y: u32) -> usize {
    y as usize * width as usize + x as usize
}

fn dominant_color(image: &RgbaImage) -> [u8; 3] {
    let mut counts = vec![0_u32; BACKGROUND_COLOR_BUCKETS];
    let mut sums = vec![[0_u64; 3]; BACKGROUND_COLOR_BUCKETS];
    for pixel in image.pixels() {
        let bucket = ((pixel[0] as usize >> 4) << 8)
            | ((pixel[1] as usize >> 4) << 4)
            | (pixel[2] as usize >> 4);
        counts[bucket] += 1;
        for channel in 0..3 {
            sums[bucket][channel] += pixel[channel] as u64;
        }
    }
    let dominant_bucket = counts
        .iter()
        .enumerate()
        .max_by_key(|(_, count)| *count)
        .map(|(bucket, _)| bucket)
        .unwrap_or_default();
    let count = counts[dominant_bucket].max(1) as u64;
    [
        (sums[dominant_bucket][0] / count) as u8,
        (sums[dominant_bucket][1] / count) as u8,
        (sums[dominant_bucket][2] / count) as u8,
    ]
}

fn color_distance(pixel: &Rgba<u8>, background: [u8; 3]) -> u8 {
    (0..3)
        .map(|channel| pixel[channel].abs_diff(background[channel]))
        .max()
        .unwrap_or(0)
}

fn color_distance_between(left: &Rgba<u8>, right: &Rgba<u8>) -> u8 {
    (0..3)
        .map(|channel| left[channel].abs_diff(right[channel]))
        .max()
        .unwrap_or(0)
}

fn pixel_luminance(pixel: &Rgba<u8>) -> u16 {
    pixel[0] as u16 * 54 + pixel[1] as u16 * 183 + pixel[2] as u16 * 19
}

fn prepare_photo_preview(
    requested_root: &Path,
    requested_path: &Path,
    max_edge: u32,
) -> Result<WatermarkPreviewAsset, Box<dyn std::error::Error>> {
    if !(MIN_PREVIEW_EDGE..=MAX_PREVIEW_EDGE).contains(&max_edge) {
        return Err(format!("预览尺寸必须位于 {MIN_PREVIEW_EDGE}–{MAX_PREVIEW_EDGE} 像素").into());
    }
    let root = canonical_directory(requested_root, "图片输入目录")?;
    let path = canonical_supported_file(requested_path, "预览图片")?;
    if !path.starts_with(&root) {
        return Err(format!("预览图片不在当前输入目录内: {}", path.display()).into());
    }
    let decoded = decode_oriented_image(&path)?;
    let (width, height) = decoded.image.dimensions();
    let preview_path = write_preview_cache(&path, "photo", max_edge, decoded.image)?;
    Ok(WatermarkPreviewAsset {
        path: path.to_string_lossy().to_string(),
        width,
        height,
        preview_path: preview_path.to_string_lossy().to_string(),
    })
}

fn write_preview_cache(
    source: &Path,
    kind: &str,
    max_edge: u32,
    image: DynamicImage,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let cache_path = preview_cache_path(source, kind, max_edge)?;
    if cache_path.is_file() {
        return Ok(cache_path);
    }
    let parent = cache_path.parent().ok_or("无法确定预览缓存目录")?;
    fs::create_dir_all(parent)?;
    let preview = image.resize(max_edge, max_edge, FilterType::Triangle);
    preview.save_with_format(&cache_path, ImageFormat::Png)?;
    Ok(cache_path)
}

fn write_generated_preview_cache(
    cache_key: &str,
    kind: &str,
    max_edge: u32,
    image: DynamicImage,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let mut hasher = DefaultHasher::new();
    cache_key.hash(&mut hasher);
    kind.hash(&mut hasher);
    max_edge.hash(&mut hasher);
    let cache_path = env::temp_dir()
        .join("raw-jpeg-matcher-thumbnails")
        .join("watermark")
        .join(format!("{:016x}", hasher.finish()))
        .join(format!("{kind}-{max_edge}.png"));
    if cache_path.is_file() {
        return Ok(cache_path);
    }
    let parent = cache_path.parent().ok_or("无法确定文字水印预览缓存目录")?;
    fs::create_dir_all(parent)?;
    let preview = image.resize(max_edge, max_edge, FilterType::Triangle);
    preview.save_with_format(&cache_path, ImageFormat::Png)?;
    Ok(cache_path)
}

fn preview_cache_path(
    source: &Path,
    kind: &str,
    max_edge: u32,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let metadata = fs::metadata(source)?;
    let mut hasher = DefaultHasher::new();
    source.hash(&mut hasher);
    metadata.len().hash(&mut hasher);
    modified_seconds(&metadata).hash(&mut hasher);
    kind.hash(&mut hasher);
    max_edge.hash(&mut hasher);
    Ok(env::temp_dir()
        .join("raw-jpeg-matcher-thumbnails")
        .join("watermark")
        .join(format!("{:016x}", hasher.finish()))
        .join(format!("{kind}-{max_edge}.png")))
}

struct DecodedImage {
    image: DynamicImage,
    exif: Option<Vec<u8>>,
    icc: Option<Vec<u8>>,
    warnings: Vec<String>,
}

fn decode_oriented_image(path: &Path) -> Result<DecodedImage, Box<dyn std::error::Error>> {
    let mut decoder = ImageReader::open(path)?
        .with_guessed_format()?
        .into_decoder()?;
    let orientation = decoder.orientation()?;
    let mut warnings = Vec::new();
    let mut exif = match decoder.exif_metadata() {
        Ok(value) => value,
        Err(error) => {
            warnings.push(format!("无法读取 EXIF: {error}"));
            None
        }
    };
    let icc = match decoder.icc_profile() {
        Ok(value) => value,
        Err(error) => {
            warnings.push(format!("无法读取 ICC: {error}"));
            None
        }
    };
    let mut image = DynamicImage::from_decoder(decoder)?;
    image.apply_orientation(orientation);

    if let Some(exif_chunk) = exif.as_mut() {
        let removed = Orientation::remove_from_exif_chunk(exif_chunk);
        if orientation != Orientation::NoTransforms && removed.is_none() {
            exif = None;
            warnings.push("无法安全移除 EXIF 方向标记，已停止写回 EXIF".to_string());
        }
    }

    Ok(DecodedImage {
        image,
        exif,
        icc,
        warnings,
    })
}

struct PreparedSource {
    path: PathBuf,
    relative_path: PathBuf,
}

struct PreparedExport {
    job_id: String,
    output_root: PathBuf,
    jpeg_quality: u8,
    watermark: RgbaImage,
    size_basis: WatermarkSizeBasis,
    sources: Vec<PreparedSource>,
    profiles: WatermarkProfiles,
}

fn prepare_export(request: WatermarkExportRequest) -> Result<PreparedExport, String> {
    validate_job_id(&request.job_id)?;
    request.profiles.validate()?;
    validate_jpeg_quality(request.jpeg_quality)?;
    if request.image_paths.is_empty() {
        return Err("没有可导出的图片".to_string());
    }
    let input_root = canonical_directory(Path::new(&request.input_root), "图片输入目录")
        .map_err(|error| error.to_string())?;
    let output_root = canonical_directory(Path::new(&request.export_dir), "水印输出目录")
        .map_err(|error| error.to_string())?;
    if output_root.starts_with(&input_root) {
        return Err("水印输出目录不能位于图片输入目录内部".to_string());
    }
    let prepared_watermark = prepare_watermark_source(&request.source)
        .map_err(|error| format!("准备玻璃水印素材失败: {error}"))?;
    let watermark = prepared_watermark.image;
    let size_basis = prepared_watermark.size_basis;
    if watermark.width() == 0 || watermark.height() == 0 {
        return Err("水印素材尺寸无效".to_string());
    }

    let mut seen = HashSet::new();
    let mut sources = Vec::with_capacity(request.image_paths.len());
    for requested in request.image_paths {
        let requested_path = Path::new(&requested);
        let path = canonical_supported_file(requested_path, "来源图片")
            .map_err(|error| error.to_string())?;
        if !path.starts_with(&input_root) {
            return Err(format!("来源图片不在输入目录内: {}", path.display()));
        }
        if !seen.insert(path.clone()) {
            return Err(format!("来源图片重复: {}", path.display()));
        }
        let (width, height, aspect) = oriented_dimensions(&path)
            .map_err(|error| format!("来源图片无法解码 {}: {error}", path.display()))?;
        validate_tile_capacity(
            (width, height),
            watermark.dimensions(),
            request.profiles.profile_for(aspect),
            size_basis,
        )?;
        let relative_path = path
            .strip_prefix(&input_root)
            .map_err(|_| format!("无法计算来源相对路径: {}", path.display()))?
            .to_path_buf();
        validate_relative_path(&relative_path)
            .map_err(|error| format!("来源相对路径无效: {error}"))?;
        sources.push(PreparedSource {
            path,
            relative_path,
        });
    }

    Ok(PreparedExport {
        job_id: request.job_id,
        output_root,
        jpeg_quality: request.jpeg_quality,
        watermark,
        size_basis,
        sources,
        profiles: request.profiles,
    })
}

fn export_prepared<F>(
    prepared: PreparedExport,
    cancelled: Arc<AtomicBool>,
    emit: F,
) -> Result<WatermarkExportSummary, String>
where
    F: Fn(WatermarkExportEvent),
{
    let total_count = prepared.sources.len() as u32;
    emit(WatermarkExportEvent::Started {
        job_id: prepared.job_id.clone(),
        total_count,
    });
    let mut summary = WatermarkExportSummary {
        total_count,
        ..WatermarkExportSummary::default()
    };

    for (offset, source) in prepared.sources.iter().enumerate() {
        if cancelled.load(Ordering::Acquire) {
            break;
        }
        let index = offset as u32 + 1;
        let relative_label = source.relative_path.to_string_lossy().to_string();
        let destination = prepared.output_root.join(&source.relative_path);
        let result = export_one_image(
            source,
            &destination,
            &prepared.output_root,
            &prepared.watermark,
            prepared.profiles,
            prepared.size_basis,
            prepared.jpeg_quality,
        );
        summary.processed_count += 1;
        match result {
            Ok(ExportOneOutcome::Exported { warnings }) => {
                summary.exported_count += 1;
                for warning in warnings {
                    emit(WatermarkExportEvent::Warning {
                        job_id: prepared.job_id.clone(),
                        relative_path: relative_label.clone(),
                        message: warning,
                    });
                }
                emit(WatermarkExportEvent::ItemFinished {
                    job_id: prepared.job_id.clone(),
                    index,
                    total_count,
                    relative_path: relative_label,
                    status: WatermarkItemStatus::Exported,
                    message: "已导出水印图片".to_string(),
                });
            }
            Ok(ExportOneOutcome::SkippedExisting) => {
                summary.skipped_existing_count += 1;
                emit(WatermarkExportEvent::ItemFinished {
                    job_id: prepared.job_id.clone(),
                    index,
                    total_count,
                    relative_path: relative_label,
                    status: WatermarkItemStatus::Skipped,
                    message: "目标已存在，已跳过".to_string(),
                });
            }
            Err(error) => {
                summary.failed_count += 1;
                emit(WatermarkExportEvent::ItemFinished {
                    job_id: prepared.job_id.clone(),
                    index,
                    total_count,
                    relative_path: relative_label,
                    status: WatermarkItemStatus::Failed,
                    message: error.to_string(),
                });
            }
        }
    }

    if cancelled.load(Ordering::Acquire) && summary.processed_count < total_count {
        summary.cancelled_remaining_count = total_count - summary.processed_count;
        emit(WatermarkExportEvent::Cancelled {
            job_id: prepared.job_id,
            processed_count: summary.processed_count,
            remaining_count: summary.cancelled_remaining_count,
        });
    }
    Ok(summary)
}

enum ExportOneOutcome {
    Exported { warnings: Vec<String> },
    SkippedExisting,
}

fn export_one_image(
    source: &PreparedSource,
    destination: &Path,
    output_root: &Path,
    watermark: &RgbaImage,
    profiles: WatermarkProfiles,
    size_basis: WatermarkSizeBasis,
    jpeg_quality: u8,
) -> Result<ExportOneOutcome, Box<dyn std::error::Error>> {
    ensure_safe_destination_parent(output_root, &source.relative_path)?;
    match fs::symlink_metadata(destination) {
        Ok(_) => return Ok(ExportOneOutcome::SkippedExisting),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }

    let mut decoded = decode_oriented_image(&source.path)?;
    let aspect = aspect_for_dimensions(decoded.image.width(), decoded.image.height());
    let profile = profiles.profile_for(aspect);
    let mut target = decoded.image.to_rgba8();
    apply_watermark(&mut target, watermark, profile, size_basis)?;

    match write_encoded_image(
        destination,
        DynamicImage::ImageRgba8(target),
        decoded.exif.take(),
        decoded.icc.take(),
        jpeg_quality,
    )? {
        WriteOutcome::Written(mut warnings) => {
            warnings.splice(0..0, decoded.warnings);
            Ok(ExportOneOutcome::Exported { warnings })
        }
        WriteOutcome::AlreadyExists => Ok(ExportOneOutcome::SkippedExisting),
    }
}

fn apply_watermark(
    target: &mut RgbaImage,
    watermark: &RgbaImage,
    profile: WatermarkProfile,
    size_basis: WatermarkSizeBasis,
) -> Result<(), Box<dyn std::error::Error>> {
    if target.width() == 0 || target.height() == 0 {
        return Err("目标图片尺寸无效".into());
    }
    match profile.layout {
        WatermarkLayout::Single => {
            let (layer, x, y) =
                prepare_watermark_layer(target.dimensions(), watermark, profile, size_basis)?;
            alpha_overlay(target, &layer, x as i64, y as i64);
        }
        WatermarkLayout::Tile => {
            let layer = prepare_watermark_image(
                target.dimensions(),
                watermark,
                profile,
                false,
                size_basis,
            )?;
            let positions = if size_basis == WatermarkSizeBasis::Height {
                let draw_dimensions = scaled_watermark_dimensions(
                    target.dimensions(),
                    watermark.dimensions(),
                    profile.size_percent,
                    size_basis,
                );
                rotated_text_tile_positions(
                    target.dimensions(),
                    draw_dimensions,
                    layer.dimensions(),
                    profile.tile_spacing_percent,
                    profile.offset_x_percent,
                    profile.offset_y_percent,
                    profile.rotation_degrees,
                )?
            } else {
                tile_positions(
                    target.dimensions(),
                    layer.dimensions(),
                    profile.tile_spacing_percent,
                    profile.offset_x_percent,
                    profile.offset_y_percent,
                )?
            };
            for (x, y) in positions {
                alpha_overlay(target, &layer, x, y);
            }
        }
    }
    Ok(())
}

fn alpha_overlay(target: &mut RgbaImage, layer: &RgbaImage, x: i64, y: i64) {
    for layer_y in 0..layer.height() {
        let target_y = y + layer_y as i64;
        if target_y < 0 || target_y >= target.height() as i64 {
            continue;
        }
        for layer_x in 0..layer.width() {
            let target_x = x + layer_x as i64;
            if target_x < 0 || target_x >= target.width() as i64 {
                continue;
            }
            let source = layer.get_pixel(layer_x, layer_y);
            if source[3] == 0 {
                continue;
            }
            let destination = target.get_pixel_mut(target_x as u32, target_y as u32);
            let source_alpha = source[3] as f32 / 255.0;
            let destination_alpha = destination[3] as f32 / 255.0;
            let output_alpha = source_alpha + destination_alpha * (1.0 - source_alpha);
            if output_alpha <= f32::EPSILON {
                *destination = Rgba([0, 0, 0, 0]);
                continue;
            }
            for channel in 0..3 {
                let source_value = source[channel] as f32 / 255.0;
                let destination_value = destination[channel] as f32 / 255.0;
                let output = (source_value * source_alpha
                    + destination_value * destination_alpha * (1.0 - source_alpha))
                    / output_alpha;
                destination[channel] = (output * 255.0).round().clamp(0.0, 255.0) as u8;
            }
            destination[3] = (output_alpha * 255.0).round().clamp(0.0, 255.0) as u8;
        }
    }
}

fn prepare_watermark_layer(
    target_dimensions: (u32, u32),
    watermark: &RgbaImage,
    profile: WatermarkProfile,
    size_basis: WatermarkSizeBasis,
) -> Result<(RgbaImage, u32, u32), Box<dyn std::error::Error>> {
    let layer = prepare_watermark_image(target_dimensions, watermark, profile, true, size_basis)?;
    let margin = safe_margin(target_dimensions.0, target_dimensions.1);
    let (x, y) = watermark_position(
        target_dimensions,
        layer.dimensions(),
        margin,
        profile.anchor,
        profile.offset_x_percent,
        profile.offset_y_percent,
    );
    Ok((layer, x, y))
}

fn prepare_watermark_image(
    target_dimensions: (u32, u32),
    watermark: &RgbaImage,
    profile: WatermarkProfile,
    fit_inside_margin: bool,
    size_basis: WatermarkSizeBasis,
) -> Result<RgbaImage, Box<dyn std::error::Error>> {
    let (target_width, target_height) = target_dimensions;
    let (desired_width, desired_height) = scaled_watermark_dimensions(
        target_dimensions,
        watermark.dimensions(),
        profile.size_percent,
        size_basis,
    );
    let mut layer = resize(
        watermark,
        desired_width,
        desired_height,
        FilterType::Lanczos3,
    );
    apply_clarity(&mut layer, profile.clarity);
    if profile.rotation_degrees.abs() > f32::EPSILON {
        layer = rotate_about_center_no_crop(
            &layer,
            profile.rotation_degrees.to_radians(),
            Interpolation::Bilinear,
            Border::Constant(Rgba([0, 0, 0, 0])),
        );
    }

    if fit_inside_margin {
        let margin = safe_margin(target_width, target_height);
        let max_width = target_width.saturating_sub(margin.saturating_mul(2)).max(1);
        let max_height = target_height
            .saturating_sub(margin.saturating_mul(2))
            .max(1);
        if layer.width() > max_width || layer.height() > max_height {
            let scale = (max_width as f32 / layer.width() as f32)
                .min(max_height as f32 / layer.height() as f32);
            let width = ((layer.width() as f32 * scale).floor() as u32).max(1);
            let height = ((layer.height() as f32 * scale).floor() as u32).max(1);
            layer = resize(&layer, width, height, FilterType::Lanczos3);
        }
    }
    Ok(layer)
}

fn validate_tile_capacity(
    target_dimensions: (u32, u32),
    watermark_dimensions: (u32, u32),
    profile: WatermarkProfile,
    size_basis: WatermarkSizeBasis,
) -> Result<(), String> {
    if profile.layout == WatermarkLayout::Single {
        return Ok(());
    }
    let layer_dimensions = estimated_rotated_layer_dimensions(
        target_dimensions,
        watermark_dimensions,
        profile,
        size_basis,
    );
    if size_basis == WatermarkSizeBasis::Height {
        let draw_dimensions = scaled_watermark_dimensions(
            target_dimensions,
            watermark_dimensions,
            profile.size_percent,
            size_basis,
        );
        rotated_text_tile_positions(
            target_dimensions,
            draw_dimensions,
            layer_dimensions,
            profile.tile_spacing_percent,
            profile.offset_x_percent,
            profile.offset_y_percent,
            profile.rotation_degrees,
        )
        .map(|_| ())
    } else {
        tile_positions(
            target_dimensions,
            layer_dimensions,
            profile.tile_spacing_percent,
            profile.offset_x_percent,
            profile.offset_y_percent,
        )
        .map(|_| ())
    }
}

fn estimated_rotated_layer_dimensions(
    target_dimensions: (u32, u32),
    watermark_dimensions: (u32, u32),
    profile: WatermarkProfile,
    size_basis: WatermarkSizeBasis,
) -> (u32, u32) {
    let (width, height) = scaled_watermark_dimensions(
        target_dimensions,
        watermark_dimensions,
        profile.size_percent,
        size_basis,
    );
    let radians = profile.rotation_degrees.to_radians();
    let cos = radians.cos().abs();
    let sin = radians.sin().abs();
    (
        (width as f32 * cos + height as f32 * sin).ceil() as u32,
        (height as f32 * cos + width as f32 * sin).ceil() as u32,
    )
}

fn scaled_watermark_dimensions(
    target_dimensions: (u32, u32),
    watermark_dimensions: (u32, u32),
    size_percent: f32,
    size_basis: WatermarkSizeBasis,
) -> (u32, u32) {
    let short_edge = target_dimensions.0.min(target_dimensions.1).max(1);
    let desired = ((short_edge as f32 * size_percent / 100.0).round() as u32).max(1);
    match size_basis {
        WatermarkSizeBasis::Width => {
            let height = ((desired as f32 * watermark_dimensions.1 as f32
                / watermark_dimensions.0.max(1) as f32)
                .round() as u32)
                .max(1);
            (desired, height)
        }
        WatermarkSizeBasis::Height => {
            let width = ((desired as f32 * watermark_dimensions.0 as f32
                / watermark_dimensions.1.max(1) as f32)
                .round() as u32)
                .max(1);
            (width, desired)
        }
    }
}

fn tile_positions(
    target_dimensions: (u32, u32),
    layer_dimensions: (u32, u32),
    spacing_percent: f32,
    offset_x_percent: f32,
    offset_y_percent: f32,
) -> Result<Vec<(i64, i64)>, String> {
    let short_edge = target_dimensions.0.min(target_dimensions.1).max(1);
    let gap = ((short_edge as f32 * spacing_percent / 100.0).round() as i64).max(1);
    let step_x = layer_dimensions.0.max(1) as i64 + gap;
    let step_y = layer_dimensions.1.max(1) as i64 + gap;
    let offset_x = (target_dimensions.0 as f32 * offset_x_percent / 100.0).round() as i64;
    let offset_y = (target_dimensions.1 as f32 * offset_y_percent / 100.0).round() as i64;
    let mut y = offset_y.rem_euclid(step_y) - layer_dimensions.1.max(1) as i64 / 2;
    let start_x = offset_x.rem_euclid(step_x) - layer_dimensions.0.max(1) as i64 / 2;
    let mut positions = Vec::new();

    while y < target_dimensions.1 as i64 {
        let mut x = start_x;
        while x < target_dimensions.0 as i64 {
            positions.push((x, y));
            if positions.len() > MAX_TILE_COUNT {
                return Err(format!(
                    "平铺数量超过单张安全上限 {MAX_TILE_COUNT}，请增大水印尺寸或平铺间距"
                ));
            }
            x += step_x;
        }
        y += step_y;
    }
    Ok(positions)
}

fn rotated_text_tile_positions(
    target_dimensions: (u32, u32),
    draw_dimensions: (u32, u32),
    layer_dimensions: (u32, u32),
    spacing_percent: f32,
    offset_x_percent: f32,
    offset_y_percent: f32,
    rotation_degrees: f32,
) -> Result<Vec<(i64, i64)>, String> {
    let target_width = target_dimensions.0.max(1) as f64;
    let target_height = target_dimensions.1.max(1) as f64;
    let short_edge = target_dimensions.0.min(target_dimensions.1).max(1);
    let gap = ((short_edge as f32 * spacing_percent / 100.0).round() as u32).max(1);
    let step_x = draw_dimensions.0.max(1).saturating_add(gap) as f64;
    let step_y = draw_dimensions.1.max(1).saturating_add(gap) as f64;
    let layer_width = layer_dimensions.0.max(1) as f64;
    let layer_height = layer_dimensions.1.max(1) as f64;
    let offset_x = (target_width * offset_x_percent as f64 / 100.0).round();
    let offset_y = (target_height * offset_y_percent as f64 / 100.0).round();
    let origin_x = target_width / 2.0 + offset_x;
    let origin_y = target_height / 2.0 + offset_y;
    let radians = (rotation_degrees as f64).to_radians();
    let cos = radians.cos();
    let sin = radians.sin();
    let expanded_corners = [
        (-layer_width / 2.0, -layer_height / 2.0),
        (target_width + layer_width / 2.0, -layer_height / 2.0),
        (-layer_width / 2.0, target_height + layer_height / 2.0),
        (
            target_width + layer_width / 2.0,
            target_height + layer_height / 2.0,
        ),
    ];
    let local_corners = expanded_corners.map(|(world_x, world_y)| {
        let delta_x = world_x - origin_x;
        let delta_y = world_y - origin_y;
        (
            delta_x * cos + delta_y * sin,
            -delta_x * sin + delta_y * cos,
        )
    });
    let minimum_local_x = local_corners
        .iter()
        .map(|(local_x, _)| *local_x)
        .fold(f64::INFINITY, f64::min);
    let maximum_local_x = local_corners
        .iter()
        .map(|(local_x, _)| *local_x)
        .fold(f64::NEG_INFINITY, f64::max);
    let minimum_local_y = local_corners
        .iter()
        .map(|(_, local_y)| *local_y)
        .fold(f64::INFINITY, f64::min);
    let maximum_local_y = local_corners
        .iter()
        .map(|(_, local_y)| *local_y)
        .fold(f64::NEG_INFINITY, f64::max);
    let minimum_column = ((minimum_local_x - step_x / 2.0) / step_x).floor() as i64 - 1;
    let maximum_column = ((maximum_local_x + step_x / 2.0) / step_x).ceil() as i64 + 1;
    let minimum_row = (minimum_local_y / step_y).floor() as i64 - 1;
    let maximum_row = (maximum_local_y / step_y).ceil() as i64 + 1;
    let mut positions = Vec::new();

    for row in minimum_row..=maximum_row {
        let stagger = if row.rem_euclid(2) == 1 {
            step_x / 2.0
        } else {
            0.0
        };
        let local_y = row as f64 * step_y;
        for column in minimum_column..=maximum_column {
            let local_x = column as f64 * step_x + stagger;
            let world_center_x = origin_x + local_x * cos - local_y * sin;
            let world_center_y = origin_y + local_x * sin + local_y * cos;
            let left = (world_center_x - layer_width / 2.0).round() as i64;
            let top = (world_center_y - layer_height / 2.0).round() as i64;
            if left >= target_dimensions.0 as i64
                || top >= target_dimensions.1 as i64
                || left + layer_dimensions.0 as i64 <= 0
                || top + layer_dimensions.1 as i64 <= 0
            {
                continue;
            }
            positions.push((left, top));
            if positions.len() > MAX_TILE_COUNT {
                return Err(format!(
                    "平铺数量超过单张安全上限 {MAX_TILE_COUNT}，请增大水印尺寸或平铺间距"
                ));
            }
        }
    }
    Ok(positions)
}

fn glass_alpha_factor(clarity: f32) -> f32 {
    1.0 - clarity.clamp(0.0, 1.0) * (1.0 - MIN_GLASS_ALPHA_FACTOR)
}

fn calibrate_text_glass_visibility(image: &mut RgbaImage) {
    for pixel in image.pixels_mut() {
        if pixel[3] == 0 {
            continue;
        }
        pixel[3] = (pixel[3] as f32 * TEXT_GLASS_ALPHA_COMPENSATION)
            .round()
            .clamp(1.0, TEXT_GLASS_MAX_ALPHA as f32) as u8;
    }
}

fn apply_clarity(image: &mut RgbaImage, clarity: f32) {
    let factor = glass_alpha_factor(clarity);
    for pixel in image.pixels_mut() {
        pixel[3] = (pixel[3] as f32 * factor).round().clamp(0.0, 255.0) as u8;
    }
}

fn safe_margin(width: u32, height: u32) -> u32 {
    let short_edge = width.min(height);
    let desired = (short_edge as f32 * SAFE_MARGIN_PERCENT / 100.0).round() as u32;
    desired
        .min(width.saturating_sub(1) / 2)
        .min(height.saturating_sub(1) / 2)
}

fn watermark_position(
    target: (u32, u32),
    layer: (u32, u32),
    margin: u32,
    anchor: WatermarkAnchor,
    offset_x_percent: f32,
    offset_y_percent: f32,
) -> (u32, u32) {
    let (target_width, target_height) = target;
    let (layer_width, layer_height) = layer;
    let min_x = margin as f32;
    let min_y = margin as f32;
    let max_x = target_width.saturating_sub(margin + layer_width) as f32;
    let max_y = target_height.saturating_sub(margin + layer_height) as f32;
    let center_x = target_width.saturating_sub(layer_width) as f32 / 2.0;
    let center_y = target_height.saturating_sub(layer_height) as f32 / 2.0;
    let (base_x, base_y) = match anchor {
        WatermarkAnchor::TopLeft => (min_x, min_y),
        WatermarkAnchor::TopCenter => (center_x, min_y),
        WatermarkAnchor::TopRight => (max_x, min_y),
        WatermarkAnchor::CenterLeft => (min_x, center_y),
        WatermarkAnchor::Center => (center_x, center_y),
        WatermarkAnchor::CenterRight => (max_x, center_y),
        WatermarkAnchor::BottomLeft => (min_x, max_y),
        WatermarkAnchor::BottomCenter => (center_x, max_y),
        WatermarkAnchor::BottomRight => (max_x, max_y),
    };
    let offset_x = target_width as f32 * offset_x_percent / 100.0;
    let offset_y = target_height as f32 * offset_y_percent / 100.0;
    (
        (base_x + offset_x).clamp(min_x, max_x).round() as u32,
        (base_y + offset_y).clamp(min_y, max_y).round() as u32,
    )
}

enum WriteOutcome {
    Written(Vec<String>),
    AlreadyExists,
}

fn write_encoded_image(
    destination: &Path,
    image: DynamicImage,
    exif: Option<Vec<u8>>,
    icc: Option<Vec<u8>>,
    jpeg_quality: u8,
) -> Result<WriteOutcome, Box<dyn std::error::Error>> {
    let file = match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
    {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            return Ok(WriteOutcome::AlreadyExists)
        }
        Err(error) => return Err(error.into()),
    };
    let extension = extension_lower(destination).ok_or("输出文件缺少扩展名")?;
    let mut warnings = Vec::new();
    let encode_result: Result<(), Box<dyn std::error::Error>> = match extension.as_str() {
        "jpg" | "jpeg" => {
            let rgb = image.to_rgb8();
            let mut encoder = JpegEncoder::new_with_quality(file, jpeg_quality);
            attach_metadata(&mut encoder, exif, icc, &mut warnings);
            encoder
                .write_image(
                    rgb.as_raw(),
                    rgb.width(),
                    rgb.height(),
                    ExtendedColorType::Rgb8,
                )
                .map_err(Into::into)
        }
        "png" => {
            let rgba = image.to_rgba8();
            let mut encoder = PngEncoder::new(file);
            attach_metadata(&mut encoder, exif, icc, &mut warnings);
            encoder
                .write_image(
                    rgba.as_raw(),
                    rgba.width(),
                    rgba.height(),
                    ExtendedColorType::Rgba8,
                )
                .map_err(Into::into)
        }
        _ => Err(format!("不支持的输出格式: {extension}").into()),
    };
    if let Err(error) = encode_result {
        let _ = fs::remove_file(destination);
        return Err(error);
    }
    Ok(WriteOutcome::Written(warnings))
}

fn validate_jpeg_quality(quality: u8) -> Result<(), String> {
    if !(MIN_JPEG_QUALITY..=MAX_JPEG_QUALITY).contains(&quality) {
        return Err(format!(
            "JPEG 导出质量超出允许范围 {MIN_JPEG_QUALITY}–{MAX_JPEG_QUALITY}: {quality}"
        ));
    }
    Ok(())
}

fn attach_metadata<E: ImageEncoder>(
    encoder: &mut E,
    exif: Option<Vec<u8>>,
    icc: Option<Vec<u8>>,
    warnings: &mut Vec<String>,
) {
    if let Some(exif) = exif {
        if let Err(error) = encoder.set_exif_metadata(exif) {
            warnings.push(format!("EXIF 写回失败: {error}"));
        }
    }
    if let Some(icc) = icc {
        if let Err(error) = encoder.set_icc_profile(icc) {
            warnings.push(format!("ICC 写回失败: {error}"));
        }
    }
}

fn ensure_safe_destination_parent(
    output_root: &Path,
    relative_path: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    validate_relative_path(relative_path)?;
    let relative_parent = relative_path.parent().unwrap_or_else(|| Path::new(""));
    let mut current = output_root.to_path_buf();
    for component in relative_parent.components() {
        let Component::Normal(segment) = component else {
            return Err("输出相对目录包含非法路径组件".into());
        };
        current.push(segment);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(format!("输出路径不是安全目录: {}", current.display()).into());
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                match fs::create_dir(&current) {
                    Ok(()) => {}
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                        let metadata = fs::symlink_metadata(&current)?;
                        if metadata.file_type().is_symlink() || !metadata.is_dir() {
                            return Err(
                                format!("输出路径不是安全目录: {}", current.display()).into()
                            );
                        }
                    }
                    Err(error) => return Err(error.into()),
                }
            }
            Err(error) => return Err(error.into()),
        }
    }
    let canonical_parent = fs::canonicalize(&current)?;
    if !canonical_parent.starts_with(output_root) {
        return Err("输出目录发生符号链接逃逸".into());
    }
    Ok(())
}

fn validate_relative_path(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err("相对路径为空或为绝对路径".into());
    }
    if path
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("相对路径包含父目录或其他非法组件".into());
    }
    Ok(())
}

fn canonical_directory(path: &Path, label: &str) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("{label}不存在或不可访问 {}: {error}", path.display()))?;
    if !canonical.is_dir() {
        return Err(format!("{label}不是目录: {}", canonical.display()).into());
    }
    Ok(canonical)
}

fn canonical_supported_file(
    path: &Path,
    label: &str,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let link_metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("{label}不存在或不可访问 {}: {error}", path.display()))?;
    if link_metadata.file_type().is_symlink() {
        return Err(format!("{label}不能是符号链接: {}", path.display()).into());
    }
    let canonical = fs::canonicalize(path)?;
    if !canonical.is_file() {
        return Err(format!("{label}不是文件: {}", canonical.display()).into());
    }
    if !is_supported_image(&canonical) {
        return Err(format!("{label}格式不受支持: {}", canonical.display()).into());
    }
    Ok(canonical)
}

fn is_supported_image(path: &Path) -> bool {
    extension_lower(path)
        .is_some_and(|extension| SUPPORTED_EXTENSIONS.contains(&extension.as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use tempfile::tempdir;

    fn default_profile() -> WatermarkProfile {
        WatermarkProfile {
            layout: WatermarkLayout::Single,
            anchor: WatermarkAnchor::BottomRight,
            clarity: 1.0,
            size_percent: 20.0,
            rotation_degrees: 0.0,
            offset_x_percent: 0.0,
            offset_y_percent: 0.0,
            tile_spacing_percent: 8.0,
        }
    }

    fn default_profiles() -> WatermarkProfiles {
        WatermarkProfiles {
            landscape: default_profile(),
            portrait: default_profile(),
            square: default_profile(),
        }
    }

    fn write_png(path: &Path, width: u32, height: u32, color: Rgba<u8>) {
        let image = RgbaImage::from_pixel(width, height, color);
        DynamicImage::ImageRgba8(image)
            .save_with_format(path, ImageFormat::Png)
            .unwrap();
    }

    fn exif_with_orientation(orientation: Orientation) -> Vec<u8> {
        vec![
            0x49,
            0x49,
            0x2a,
            0x00,
            0x08,
            0x00,
            0x00,
            0x00,
            0x01,
            0x00,
            0x12,
            0x01,
            0x03,
            0x00,
            0x01,
            0x00,
            0x00,
            0x00,
            orientation.to_exif(),
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
        ]
    }

    fn write_jpeg_with_metadata(
        path: &Path,
        width: u32,
        height: u32,
        orientation: Orientation,
        icc: &[u8],
    ) {
        let file = fs::File::create(path).unwrap();
        let pixels = vec![120_u8; width as usize * height as usize * 3];
        let mut encoder = JpegEncoder::new_with_quality(file, 90);
        encoder
            .set_exif_metadata(exif_with_orientation(orientation))
            .unwrap();
        encoder.set_icc_profile(icc.to_vec()).unwrap();
        encoder
            .write_image(&pixels, width, height, ExtendedColorType::Rgb8)
            .unwrap();
    }

    fn write_opaque_logo_jpeg(path: &Path) {
        let width = 64_u32;
        let height = 64_u32;
        let mut pixels = vec![0_u8; width as usize * height as usize * 3];
        for y in 0..height {
            for x in 0..width {
                let offset = (y as usize * width as usize + x as usize) * 3;
                let color = if (16..48).contains(&x) && (16..48).contains(&y) {
                    [245, 245, 245]
                } else {
                    [225, 25, 35]
                };
                pixels[offset..offset + 3].copy_from_slice(&color);
            }
        }
        let file = fs::File::create(path).unwrap();
        JpegEncoder::new_with_quality(file, 95)
            .write_image(&pixels, width, height, ExtendedColorType::Rgb8)
            .unwrap();
    }

    fn export_request(
        job_id: &str,
        input_root: &Path,
        output_root: &Path,
        watermark_path: &Path,
        image_paths: Vec<PathBuf>,
    ) -> WatermarkExportRequest {
        WatermarkExportRequest {
            job_id: job_id.to_string(),
            input_root: input_root.to_string_lossy().to_string(),
            export_dir: output_root.to_string_lossy().to_string(),
            jpeg_quality: MAX_JPEG_QUALITY,
            source: WatermarkSource::Image {
                path: watermark_path.to_string_lossy().to_string(),
            },
            image_paths: image_paths
                .into_iter()
                .map(|path| path.to_string_lossy().to_string())
                .collect(),
            profiles: default_profiles(),
        }
    }

    #[test]
    fn jpeg_quality_is_validated_and_changes_encoding() {
        assert!(validate_jpeg_quality(0).is_err());
        assert!(validate_jpeg_quality(1).is_ok());
        assert!(validate_jpeg_quality(100).is_ok());
        assert!(validate_jpeg_quality(101).is_err());

        let root = tempdir().unwrap();
        let low_path = root.path().join("low.jpg");
        let high_path = root.path().join("high.jpg");
        let image = RgbaImage::from_fn(256, 256, |x, y| {
            Rgba([
                ((x * 13 + y * 7) % 256) as u8,
                ((x * 3 + y * 17) % 256) as u8,
                ((x * 19 + y * 5) % 256) as u8,
                255,
            ])
        });

        assert!(matches!(
            write_encoded_image(
                &low_path,
                DynamicImage::ImageRgba8(image.clone()),
                None,
                None,
                20,
            )
            .unwrap(),
            WriteOutcome::Written(_)
        ));
        assert!(matches!(
            write_encoded_image(&high_path, DynamicImage::ImageRgba8(image), None, None, 100,)
                .unwrap(),
            WriteOutcome::Written(_)
        ));
        assert!(fs::metadata(high_path).unwrap().len() > fs::metadata(low_path).unwrap().len());
    }

    #[test]
    fn png_encoding_ignores_jpeg_quality() {
        let root = tempdir().unwrap();
        let low_path = root.path().join("low.png");
        let high_path = root.path().join("high.png");
        let image =
            DynamicImage::ImageRgba8(RgbaImage::from_pixel(32, 24, Rgba([20, 80, 160, 200])));

        write_encoded_image(&low_path, image.clone(), None, None, 1).unwrap();
        write_encoded_image(&high_path, image, None, None, 100).unwrap();

        assert_eq!(fs::read(low_path).unwrap(), fs::read(high_path).unwrap());
    }

    #[test]
    fn scan_is_recursive_sorted_and_skips_unsupported_files() {
        let root = tempdir().unwrap();
        fs::create_dir(root.path().join("nested")).unwrap();
        write_png(&root.path().join("z.png"), 8, 4, Rgba([10, 20, 30, 255]));
        write_png(
            &root.path().join("nested/a.png"),
            4,
            8,
            Rgba([30, 20, 10, 255]),
        );
        fs::write(root.path().join("notes.txt"), b"ignored").unwrap();

        let response = scan_watermark_directory(root.path()).unwrap();

        assert_eq!(response.images.len(), 2);
        assert_eq!(response.images[0].relative_path, "nested/a.png");
        assert_eq!(response.images[0].aspect, AspectKind::Portrait);
        assert_eq!(response.images[1].relative_path, "z.png");
        assert_eq!(response.images[1].aspect, AspectKind::Landscape);
        assert_eq!(response.skipped_count, 1);
    }

    #[test]
    fn scan_uses_exif_orientation_for_dimensions_and_aspect() {
        let root = tempdir().unwrap();
        let path = root.path().join("rotated.jpg");
        write_jpeg_with_metadata(&path, 8, 4, Orientation::Rotate90, b"test-icc-profile");

        let response = scan_watermark_directory(root.path()).unwrap();

        assert_eq!(response.images[0].width, 4);
        assert_eq!(response.images[0].height, 8);
        assert_eq!(response.images[0].aspect, AspectKind::Portrait);
    }

    #[test]
    fn watermark_asset_reports_transparency_and_uses_scoped_cache() {
        let root = tempdir().unwrap();
        let path = root.path().join("logo.png");
        write_png(&path, 3, 2, Rgba([255, 20, 10, 80]));

        let info = inspect_watermark_file(&path).unwrap();

        assert!(info.has_transparency);
        assert!(info.source_has_transparency);
        assert!(info.glass_processed);
        assert!(Path::new(&info.preview_path).is_file());
        assert!(Path::new(&info.preview_path)
            .starts_with(env::temp_dir().join("raw-jpeg-matcher-thumbnails")));
    }

    #[test]
    fn opaque_watermark_becomes_translucent_glass_with_visible_edges() {
        let root = tempdir().unwrap();
        let path = root.path().join("opaque-logo.png");
        let mut logo = RgbaImage::from_pixel(15, 15, Rgba([245, 245, 245, 255]));
        for y in 4..=10 {
            for x in 4..=10 {
                *logo.get_pixel_mut(x, y) = Rgba([20, 20, 20, 255]);
            }
        }
        DynamicImage::ImageRgba8(logo)
            .save_with_format(&path, ImageFormat::Png)
            .unwrap();

        let prepared = prepare_watermark_asset(&path).unwrap();
        let info = inspect_watermark_file(&path).unwrap();

        assert!(!prepared.source_has_transparency);
        assert!(prepared.glass_processed);
        assert_eq!(prepared.image.get_pixel(0, 0)[3], 0);
        assert_eq!(prepared.image.get_pixel(4, 7)[3], GLASS_HIGHLIGHT_ALPHA);
        assert_eq!(prepared.image.get_pixel(5, 7)[3], GLASS_DARK_RIM_ALPHA);
        assert_eq!(prepared.image.get_pixel(7, 7)[3], GLASS_FILL_ALPHA);
        assert_eq!(&prepared.image.get_pixel(4, 7).0[..3], &[248, 252, 255]);
        assert!(!info.source_has_transparency);
        assert!(info.glass_processed);
        assert!(info.has_transparency);
    }

    #[test]
    fn opaque_watermark_uses_dominant_background_and_discards_thin_frame() {
        let mut logo = RgbaImage::from_pixel(24, 20, Rgba([235, 0, 18, 255]));
        for x in 0..logo.width() {
            *logo.get_pixel_mut(x, 0) = Rgba([0, 0, 0, 255]);
            *logo.get_pixel_mut(x, logo.height() - 1) = Rgba([0, 0, 0, 255]);
        }
        for y in 0..logo.height() {
            *logo.get_pixel_mut(0, y) = Rgba([0, 0, 0, 255]);
            *logo.get_pixel_mut(logo.width() - 1, y) = Rgba([0, 0, 0, 255]);
        }
        for y in 6..=13 {
            for x in 7..=16 {
                *logo.get_pixel_mut(x, y) = Rgba([250, 250, 250, 255]);
            }
        }

        let glass = create_glass_watermark(&logo, false).unwrap();

        assert_eq!(glass.get_pixel(0, 0)[3], 0);
        assert_eq!(glass.get_pixel(4, 4)[3], 0);
        assert!(glass.get_pixel(7, 9)[3] > 0);
        assert_eq!(glass.get_pixel(11, 9)[3], GLASS_FILL_ALPHA);
    }

    #[test]
    fn opaque_watermark_without_foreground_is_rejected() {
        let solid = RgbaImage::from_pixel(4, 4, Rgba([200, 20, 30, 255]));

        let error = create_glass_watermark(&solid, false)
            .unwrap_err()
            .to_string();

        assert!(error.contains("没有可保留的主体"));
    }

    #[test]
    fn opaque_jpeg_watermark_has_glass_fill_before_preview_and_export() {
        let root = tempdir().unwrap();
        let path = root.path().join("logo.jpeg");
        write_opaque_logo_jpeg(&path);

        let prepared = prepare_watermark_asset(&path).unwrap();

        assert!(!prepared.source_has_transparency);
        assert!(prepared.glass_processed);
        assert_eq!(prepared.image.get_pixel(0, 0)[3], 0);
        assert!(prepared.image.get_pixel(16, 32)[3] > 0);
        assert_eq!(prepared.image.get_pixel(32, 32)[3], GLASS_FILL_ALPHA);
    }

    #[test]
    fn transparent_multicolor_watermark_keeps_internal_glass_boundaries() {
        let mut logo = RgbaImage::from_pixel(15, 15, Rgba([0, 0, 0, 0]));
        for y in 2..=12 {
            for x in 2..=12 {
                *logo.get_pixel_mut(x, y) = if x <= 7 {
                    Rgba([15, 20, 25, 255])
                } else {
                    Rgba([245, 245, 245, 255])
                };
            }
        }

        let glass = create_glass_watermark(&logo, true).unwrap();

        assert_eq!(glass.get_pixel(0, 0)[3], 0);
        assert_eq!(glass.get_pixel(4, 7)[3], GLASS_FILL_ALPHA);
        assert!(glass.get_pixel(7, 7)[3] > GLASS_FILL_ALPHA);
        assert!(glass.get_pixel(8, 7)[3] > GLASS_FILL_ALPHA);
        assert_ne!(&glass.get_pixel(7, 7).0[..3], &glass.get_pixel(8, 7).0[..3]);
    }

    #[test]
    fn text_watermark_validation_rejects_empty_multiline_and_oversized_content() {
        assert!(validate_text_watermark("   ").is_err());
        assert!(validate_text_watermark("第一行\n第二行").is_err());
        assert!(validate_text_watermark(&"a".repeat(MAX_TEXT_WATERMARK_CHARACTERS + 1)).is_err());
        assert_eq!(validate_text_watermark("  Glass  ").unwrap(), "Glass");
    }

    #[test]
    fn system_font_catalog_renders_transparent_glass_text_asset() {
        let store = font_store().unwrap();
        assert!(!store.catalog.fonts.is_empty());
        assert!(store
            .catalog
            .fonts
            .iter()
            .any(|font| font.id == store.catalog.default_font_id));
        let request = TextWatermarkRequest {
            text: "Glass".to_string(),
            font_id: store.catalog.default_font_id.clone(),
        };
        let prepared =
            prepare_text_watermark_asset("Glass", &store.catalog.default_font_id).unwrap();

        let info = inspect_text_watermark_request(&request).unwrap();
        let max_alpha = prepared
            .image
            .pixels()
            .map(|pixel| pixel[3])
            .max()
            .unwrap_or_default();

        assert_eq!(info.source_kind, WatermarkSourceKind::Text);
        assert_eq!(info.size_basis, WatermarkSizeBasis::Height);
        assert!(info.has_transparency);
        assert!(info.glass_processed);
        assert_eq!(max_alpha, TEXT_GLASS_MAX_ALPHA);
        assert!(prepared.image.pixels().all(|pixel| pixel[3] < u8::MAX));
        assert!(Path::new(&info.preview_path).is_file());
        assert!(Path::new(&info.preview_path)
            .starts_with(env::temp_dir().join("raw-jpeg-matcher-thumbnails")));
    }

    #[test]
    fn preview_rejects_source_outside_input_root() {
        let input = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let path = outside.path().join("outside.png");
        write_png(&path, 4, 4, Rgba([1, 2, 3, 255]));

        let error = prepare_photo_preview(input.path(), &path, 256)
            .unwrap_err()
            .to_string();

        assert!(error.contains("不在当前输入目录内"));
    }

    #[test]
    fn default_geometry_uses_short_edge_and_safe_margin() {
        let watermark = RgbaImage::from_pixel(100, 50, Rgba([255, 255, 255, 255]));

        let (layer, x, y) = prepare_watermark_layer(
            (1_000, 500),
            &watermark,
            default_profile(),
            WatermarkSizeBasis::Width,
        )
        .unwrap();

        assert_eq!(layer.dimensions(), (100, 50));
        assert_eq!((x, y), (885, 435));
    }

    #[test]
    fn text_size_basis_uses_asset_height_and_preserves_aspect_ratio() {
        assert_eq!(
            scaled_watermark_dimensions((1_000, 500), (400, 100), 20.0, WatermarkSizeBasis::Height,),
            (400, 100),
        );
        assert_eq!(
            scaled_watermark_dimensions((1_000, 500), (400, 100), 20.0, WatermarkSizeBasis::Width,),
            (100, 25),
        );
    }

    #[test]
    fn rotation_and_extreme_offset_keep_layer_inside_margin() {
        let watermark = RgbaImage::from_pixel(200, 80, Rgba([255, 255, 255, 255]));
        let profile = WatermarkProfile {
            rotation_degrees: 42.0,
            offset_x_percent: 50.0,
            offset_y_percent: -50.0,
            ..default_profile()
        };

        let (layer, x, y) =
            prepare_watermark_layer((800, 600), &watermark, profile, WatermarkSizeBasis::Width)
                .unwrap();
        let margin = safe_margin(800, 600);

        assert!(x >= margin);
        assert!(y >= margin);
        assert!(x + layer.width() <= 800 - margin);
        assert!(y + layer.height() <= 600 - margin);
    }

    #[test]
    fn clarity_keeps_a_visible_edge_floor() {
        let mut target = RgbaImage::from_pixel(100, 100, Rgba([0, 0, 0, 255]));
        let watermark = RgbaImage::from_pixel(10, 10, Rgba([255, 0, 0, 255]));
        let profile = WatermarkProfile {
            anchor: WatermarkAnchor::Center,
            clarity: 1.0,
            size_percent: 20.0,
            ..default_profile()
        };

        apply_watermark(&mut target, &watermark, profile, WatermarkSizeBasis::Width).unwrap();

        let center = target.get_pixel(50, 50);
        assert!(center[0] >= 88 && center[0] <= 90);
        assert_eq!(center[1], 0);
        assert_eq!(center[3], 255);
        assert_eq!(glass_alpha_factor(0.0), 1.0);
        assert!((glass_alpha_factor(1.0) - MIN_GLASS_ALPHA_FACTOR).abs() < f32::EPSILON);
    }

    #[test]
    fn text_visibility_calibration_strengthens_material_before_shared_clarity_curve() {
        let mut text_glass = RgbaImage::from_raw(
            5,
            1,
            vec![
                255,
                255,
                255,
                0,
                255,
                255,
                255,
                1,
                255,
                255,
                255,
                GLASS_FILL_ALPHA,
                255,
                255,
                255,
                GLASS_DARK_RIM_ALPHA,
                255,
                255,
                255,
                GLASS_HIGHLIGHT_ALPHA,
            ],
        )
        .unwrap();

        calibrate_text_glass_visibility(&mut text_glass);

        let calibrated = text_glass
            .pixels()
            .map(|pixel| pixel[3])
            .collect::<Vec<_>>();
        assert_eq!(calibrated, vec![0, 1, 86, 140, TEXT_GLASS_MAX_ALPHA]);

        let clarity = 0.4;
        let shared_factor = glass_alpha_factor(clarity);
        apply_clarity(&mut text_glass, clarity);
        let adjusted = text_glass
            .pixels()
            .map(|pixel| pixel[3])
            .collect::<Vec<_>>();
        let expected = calibrated
            .iter()
            .map(|alpha| (*alpha as f32 * shared_factor).round() as u8)
            .collect::<Vec<_>>();
        assert_eq!(adjusted, expected);
    }

    #[test]
    fn tile_layout_repeats_watermark_and_keeps_spacing() {
        let mut target = RgbaImage::from_pixel(100, 100, Rgba([0, 0, 0, 255]));
        let watermark = RgbaImage::from_pixel(10, 10, Rgba([255, 0, 0, 255]));
        let profile = WatermarkProfile {
            layout: WatermarkLayout::Tile,
            clarity: 0.0,
            size_percent: 20.0,
            tile_spacing_percent: 10.0,
            ..default_profile()
        };

        apply_watermark(&mut target, &watermark, profile, WatermarkSizeBasis::Width).unwrap();

        assert_eq!(target.get_pixel(0, 0)[0], 255);
        assert_eq!(target.get_pixel(30, 30)[0], 255);
        assert_eq!(target.get_pixel(15, 15)[0], 0);
    }

    #[test]
    fn opaque_jpeg_tile_export_keeps_translucent_glass_fill_and_edges() {
        let root = tempdir().unwrap();
        let input = root.path().join("input");
        let output = root.path().join("output");
        fs::create_dir(&input).unwrap();
        fs::create_dir(&output).unwrap();
        let source = input.join("photo.png");
        let watermark = root.path().join("logo.jpeg");
        write_png(&source, 120, 80, Rgba([0, 0, 0, 255]));
        write_opaque_logo_jpeg(&watermark);
        let mut request = export_request("opaque-tile", &input, &output, &watermark, vec![source]);
        request.profiles.landscape = WatermarkProfile {
            layout: WatermarkLayout::Tile,
            size_percent: 20.0,
            tile_spacing_percent: 10.0,
            ..default_profile()
        };

        let prepared = prepare_export(request).unwrap();
        let summary = export_prepared(prepared, Arc::new(AtomicBool::new(false)), |_| {}).unwrap();
        let result = image::open(output.join("photo.png")).unwrap().to_rgb8();
        let glass_pixels = result
            .pixels()
            .filter(|pixel| pixel[0] > 15 && pixel[1] > 15 && pixel[2] > 15)
            .count();
        let solid_pixels = result
            .pixels()
            .filter(|pixel| pixel[0] > 210 && pixel[1] > 210 && pixel[2] > 210)
            .count();

        assert_eq!(summary.exported_count, 1);
        assert!(glass_pixels > 100);
        assert_eq!(solid_pixels, 0);
    }

    #[test]
    fn text_source_tile_export_uses_glass_without_opaque_background() {
        let root = tempdir().unwrap();
        let input = root.path().join("input");
        let output = root.path().join("output");
        fs::create_dir(&input).unwrap();
        fs::create_dir(&output).unwrap();
        let source = input.join("photo.png");
        write_png(&source, 240, 160, Rgba([0, 0, 0, 255]));
        let default_font_id = font_store().unwrap().catalog.default_font_id.clone();
        let mut request = WatermarkExportRequest {
            job_id: "text-tile".to_string(),
            input_root: input.to_string_lossy().to_string(),
            export_dir: output.to_string_lossy().to_string(),
            jpeg_quality: MAX_JPEG_QUALITY,
            source: WatermarkSource::Text {
                text: "Glass".to_string(),
                font_id: default_font_id,
            },
            image_paths: vec![source.to_string_lossy().to_string()],
            profiles: default_profiles(),
        };
        request.profiles.landscape = WatermarkProfile {
            layout: WatermarkLayout::Tile,
            clarity: 1.0,
            size_percent: 12.0,
            tile_spacing_percent: 10.0,
            ..default_profile()
        };

        let prepared = prepare_export(request).unwrap();
        assert_eq!(prepared.size_basis, WatermarkSizeBasis::Height);
        let summary = export_prepared(prepared, Arc::new(AtomicBool::new(false)), |_| {}).unwrap();
        let result = image::open(output.join("photo.png")).unwrap().to_rgb8();
        let glass_pixels = result
            .pixels()
            .filter(|pixel| pixel[0] > 8 || pixel[1] > 8 || pixel[2] > 8)
            .count();
        let opaque_pixels = result
            .pixels()
            .filter(|pixel| pixel[0] > 220 && pixel[1] > 220 && pixel[2] > 220)
            .count();

        assert_eq!(summary.exported_count, 1);
        assert!(glass_pixels > 100);
        assert_eq!(opaque_pixels, 0);
    }

    #[test]
    fn excessive_tile_count_is_rejected() {
        let error = tile_positions((100_000, 100_000), (1, 1), 1.0, 0.0, 0.0).unwrap_err();

        assert!(error.contains("平铺数量超过单张安全上限"));
    }

    #[test]
    fn rotated_text_grid_keeps_local_short_edge_spacing() {
        let unrotated =
            rotated_text_tile_positions((1_000, 500), (150, 50), (150, 50), 2.0, 0.0, 0.0, 0.0)
                .unwrap();
        assert!(unrotated.contains(&(425, 225)));
        assert!(unrotated.contains(&(505, 285)));

        let rotation_degrees = -25.0_f32;
        let radians = (rotation_degrees as f64).to_radians();
        let cos = radians.cos();
        let sin = radians.sin();
        let rotated = rotated_text_tile_positions(
            (1_000, 500),
            (150, 50),
            (158, 109),
            2.0,
            0.0,
            0.0,
            rotation_degrees,
        )
        .unwrap();
        let nearest = |target_x: f64, target_y: f64| {
            rotated
                .iter()
                .copied()
                .min_by(|left, right| {
                    let left_x = left.0 as f64 + 79.0;
                    let left_y = left.1 as f64 + 54.5;
                    let right_x = right.0 as f64 + 79.0;
                    let right_y = right.1 as f64 + 54.5;
                    let left_distance = (left_x - target_x).powi(2) + (left_y - target_y).powi(2);
                    let right_distance =
                        (right_x - target_x).powi(2) + (right_y - target_y).powi(2);
                    left_distance.total_cmp(&right_distance)
                })
                .unwrap()
        };
        let center = nearest(500.0, 250.0);
        let next_row = nearest(
            500.0 + 80.0 * cos - 60.0 * sin,
            250.0 + 80.0 * sin + 60.0 * cos,
        );
        let delta_x = (next_row.0 - center.0) as f64;
        let delta_y = (next_row.1 - center.1) as f64;
        let local_long_axis_distance = delta_x * cos + delta_y * sin;
        let local_short_axis_distance = -delta_x * sin + delta_y * cos;

        assert!(109 > 60);
        assert_eq!(center, (421, 196));
        assert_eq!(next_row, (519, 216));
        assert!((local_long_axis_distance - 80.0).abs() <= 1.0);
        assert!((local_short_axis_distance - 60.0).abs() <= 1.0);
        assert!(rotated.iter().any(|(x, _)| *x <= 0 && *x + 158 > 0));
        assert!(rotated.iter().any(|(x, _)| *x < 1_000 && *x + 158 >= 1_000));
        assert!(rotated.iter().any(|(_, y)| *y <= 0 && *y + 109 > 0));
        assert!(rotated.iter().any(|(_, y)| *y < 500 && *y + 109 >= 500));

        let shifted = rotated_text_tile_positions(
            (1_000, 500),
            (150, 50),
            (158, 109),
            2.0,
            10.0,
            -10.0,
            rotation_degrees,
        )
        .unwrap();
        assert_ne!(rotated, shifted);
    }

    #[test]
    fn rotated_text_tile_count_is_rejected() {
        let error =
            rotated_text_tile_positions((100_000, 100_000), (1, 1), (2, 2), 1.0, 0.0, 0.0, -25.0)
                .unwrap_err();

        assert!(error.contains("平铺数量超过单张安全上限"));
    }

    #[test]
    fn image_tile_rows_remain_aligned() {
        let aligned = tile_positions((1_000, 500), (150, 50), 2.0, 0.0, 0.0).unwrap();
        let aligned_second_row = aligned.iter().find(|(_, y)| *y == 35).unwrap();

        assert_eq!(aligned[0], (-75, -25));
        assert_eq!(*aligned_second_row, (-75, 35));
    }

    #[test]
    fn export_preserves_metadata_orientation_and_relative_path() {
        let root = tempdir().unwrap();
        let input = root.path().join("input");
        let output = root.path().join("output");
        fs::create_dir_all(input.join("nested")).unwrap();
        fs::create_dir(&output).unwrap();
        let source = input.join("nested/photo.jpg");
        let watermark = root.path().join("logo.png");
        let icc = b"test-icc-profile";
        write_jpeg_with_metadata(&source, 8, 4, Orientation::Rotate90, icc);
        write_png(&watermark, 2, 1, Rgba([255, 255, 255, 180]));
        let request = export_request("metadata-job", &input, &output, &watermark, vec![source]);
        let prepared = prepare_export(request).unwrap();

        let summary = export_prepared(prepared, Arc::new(AtomicBool::new(false)), |_| {}).unwrap();

        assert_eq!(summary.exported_count, 1);
        let destination = output.join("nested/photo.jpg");
        let mut decoder = ImageReader::open(destination)
            .unwrap()
            .with_guessed_format()
            .unwrap()
            .into_decoder()
            .unwrap();
        assert_eq!(decoder.dimensions(), (4, 8));
        assert_eq!(decoder.orientation().unwrap(), Orientation::NoTransforms);
        assert_eq!(decoder.icc_profile().unwrap().unwrap(), icc);
        let exif = decoder.exif_metadata().unwrap().unwrap();
        assert_eq!(
            Orientation::from_exif_chunk(&exif),
            Some(Orientation::NoTransforms)
        );
    }

    #[test]
    fn export_skips_existing_destination_without_overwrite() {
        let root = tempdir().unwrap();
        let input = root.path().join("input");
        let output = root.path().join("output");
        fs::create_dir(&input).unwrap();
        fs::create_dir(&output).unwrap();
        let source = input.join("photo.png");
        let watermark = root.path().join("logo.png");
        write_png(&source, 20, 10, Rgba([10, 20, 30, 255]));
        write_png(&watermark, 2, 1, Rgba([255, 255, 255, 180]));
        fs::write(output.join("photo.png"), b"keep-me").unwrap();
        let prepared = prepare_export(export_request(
            "collision-job",
            &input,
            &output,
            &watermark,
            vec![source],
        ))
        .unwrap();

        let summary = export_prepared(prepared, Arc::new(AtomicBool::new(false)), |_| {}).unwrap();

        assert_eq!(summary.skipped_existing_count, 1);
        assert_eq!(fs::read(output.join("photo.png")).unwrap(), b"keep-me");
    }

    #[test]
    fn export_rejects_output_inside_input_before_writing() {
        let root = tempdir().unwrap();
        let input = root.path().join("input");
        let output = input.join("exports");
        fs::create_dir_all(&output).unwrap();
        let source = input.join("photo.png");
        let watermark = root.path().join("logo.png");
        write_png(&source, 10, 10, Rgba([10, 20, 30, 255]));
        write_png(&watermark, 2, 1, Rgba([255, 255, 255, 180]));

        let error = prepare_export(export_request(
            "inside-output",
            &input,
            &output,
            &watermark,
            vec![source],
        ))
        .err()
        .unwrap();

        assert!(error.contains("不能位于图片输入目录内部"));
    }

    #[test]
    fn export_continues_after_an_item_disappears() {
        let root = tempdir().unwrap();
        let input = root.path().join("input");
        let output = root.path().join("output");
        fs::create_dir(&input).unwrap();
        fs::create_dir(&output).unwrap();
        let missing = input.join("a.png");
        let valid = input.join("b.png");
        let watermark = root.path().join("logo.png");
        write_png(&missing, 10, 10, Rgba([10, 20, 30, 255]));
        write_png(&valid, 10, 10, Rgba([30, 20, 10, 255]));
        write_png(&watermark, 2, 1, Rgba([255, 255, 255, 180]));
        let prepared = prepare_export(export_request(
            "continue-job",
            &input,
            &output,
            &watermark,
            vec![missing.clone(), valid],
        ))
        .unwrap();
        fs::remove_file(missing).unwrap();

        let summary = export_prepared(prepared, Arc::new(AtomicBool::new(false)), |_| {}).unwrap();

        assert_eq!(summary.failed_count, 1);
        assert_eq!(summary.exported_count, 1);
        assert!(output.join("b.png").is_file());
    }

    #[test]
    fn cancellation_stops_before_starting_the_next_item() {
        let root = tempdir().unwrap();
        let input = root.path().join("input");
        let output = root.path().join("output");
        fs::create_dir(&input).unwrap();
        fs::create_dir(&output).unwrap();
        let first = input.join("a.png");
        let second = input.join("b.png");
        let watermark = root.path().join("logo.png");
        write_png(&first, 10, 10, Rgba([10, 20, 30, 255]));
        write_png(&second, 10, 10, Rgba([30, 20, 10, 255]));
        write_png(&watermark, 2, 1, Rgba([255, 255, 255, 180]));
        let prepared = prepare_export(export_request(
            "cancel-job",
            &input,
            &output,
            &watermark,
            vec![first, second],
        ))
        .unwrap();
        let cancelled = Arc::new(AtomicBool::new(true));
        let events = Mutex::new(Vec::new());

        let summary = export_prepared(prepared, cancelled, |event| {
            events.lock().unwrap().push(event);
        })
        .unwrap();

        assert_eq!(summary.processed_count, 0);
        assert_eq!(summary.cancelled_remaining_count, 2);
        assert!(matches!(
            events.lock().unwrap().last(),
            Some(WatermarkExportEvent::Cancelled {
                remaining_count: 2,
                ..
            })
        ));
    }

    #[test]
    fn job_state_is_mutually_exclusive_and_cancellable() {
        let state = WatermarkJobState::default();
        let cancelled = state.begin("job-a").unwrap();

        assert!(state.begin("job-b").is_err());
        assert!(state.cancel("job-a").unwrap());
        assert!(cancelled.load(Ordering::Acquire));
        state.finish("job-a");
        assert!(state.begin("job-b").is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn export_rejects_symlink_source() {
        use std::os::unix::fs::symlink;

        let root = tempdir().unwrap();
        let input = root.path().join("input");
        let output = root.path().join("output");
        fs::create_dir(&input).unwrap();
        fs::create_dir(&output).unwrap();
        let real = root.path().join("real.png");
        let alias = input.join("alias.png");
        let watermark = root.path().join("logo.png");
        write_png(&real, 10, 10, Rgba([10, 20, 30, 255]));
        write_png(&watermark, 2, 1, Rgba([255, 255, 255, 180]));
        symlink(&real, &alias).unwrap();

        let error = prepare_export(export_request(
            "symlink-job",
            &input,
            &output,
            &watermark,
            vec![alias],
        ))
        .err()
        .unwrap();

        assert!(error.contains("不能是符号链接"));
    }

    #[test]
    fn serialized_contract_uses_camel_case_fields_and_tags() {
        let event = WatermarkExportEvent::ItemFinished {
            job_id: "job".to_string(),
            index: 1,
            total_count: 2,
            relative_path: "a.png".to_string(),
            status: WatermarkItemStatus::Exported,
            message: "ok".to_string(),
        };
        let json = serde_json::to_value(event).unwrap();

        assert_eq!(json["type"], "itemFinished");
        assert_eq!(json["jobId"], "job");
        assert_eq!(json["totalCount"], 2);
        assert_eq!(json["status"], "exported");
        assert!(json.get("total_count").is_none());

        let profile = serde_json::to_value(default_profile()).unwrap();
        assert_eq!(profile["layout"], "single");
        assert_eq!(profile["clarity"], 1.0);
        assert_eq!(profile["tileSpacingPercent"], 8.0);
        assert!(profile.get("tile_spacing_percent").is_none());

        let source = serde_json::to_value(WatermarkSource::Text {
            text: "版权".to_string(),
            font_id: "PingFangSC-Regular".to_string(),
        })
        .unwrap();
        assert_eq!(source["type"], "text");
        assert_eq!(source["fontId"], "PingFangSC-Regular");
        assert!(source.get("font_id").is_none());
    }
}
