mod raw_matcher;
mod shared;
mod watermark;

use std::{path::PathBuf, process::Command};

use raw_matcher::{collect_jpeg_inputs, export_raw_files, match_raw_files, raw_thumbnail_path};
use watermark::{export_watermarked_images, scan_watermark_images};

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
