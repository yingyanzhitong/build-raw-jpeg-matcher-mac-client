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
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};
use walkdir::WalkDir;

use crate::shared::{
    canonical_path_string, extension_lower, file_name, is_macos_metadata_dir, modified_seconds,
    safe_relative_path,
};

const WATERMARK_IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png"];
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
pub(crate) fn scan_watermark_images(root: String) -> Result<WatermarkScanResponse, String> {
    scan_watermark_directory(&root).map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn export_watermarked_images(
    input_root: String,
    images: Vec<WatermarkImageInput>,
    export_dir: String,
    source: WatermarkSource,
    config: WatermarkConfig,
) -> Result<WatermarkExportResponse, String> {
    export_watermarked_files(&input_root, &images, &export_dir, &source, &config)
        .map_err(|error| error.to_string())
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

fn is_watermark_image_path(path: &Path) -> bool {
    extension_lower(path)
        .map(|extension| WATERMARK_IMAGE_EXTENSIONS.contains(&extension.as_str()))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, path::Path};
    use tempfile::tempdir;

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
}
