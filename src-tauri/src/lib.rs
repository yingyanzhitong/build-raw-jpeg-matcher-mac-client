mod file_separator;
mod raw_matcher;
mod shared;
mod watermark;

use file_separator::{export_separated_files, scan_separator_source};
use std::{path::PathBuf, process::Command};

use raw_matcher::{
    collect_match_inputs, export_matched_files, file_thumbnail_path, match_counterpart_files,
    matcher_capabilities,
};
use watermark::{
    cancel_watermark_export, export_watermarked_images, inspect_text_watermark,
    inspect_watermark_asset, list_watermark_fonts, scan_watermark_source, watermark_preview_asset,
    WatermarkJobState,
};

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(WatermarkJobState::default())
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
            matcher_capabilities,
            collect_match_inputs,
            match_counterpart_files,
            export_matched_files,
            scan_separator_source,
            export_separated_files,
            scan_watermark_source,
            inspect_watermark_asset,
            list_watermark_fonts,
            inspect_text_watermark,
            watermark_preview_asset,
            export_watermarked_images,
            cancel_watermark_export,
            open_file_path,
            file_thumbnail_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
