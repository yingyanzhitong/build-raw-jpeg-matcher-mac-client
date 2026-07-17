mod file_separator;
mod raw_matcher;
mod shared;
mod watermark;

use file_separator::{export_separated_files, scan_separator_source};
use std::{path::PathBuf, process::Command};

#[cfg(desktop)]
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    Emitter,
};

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
    let builder = tauri::Builder::default()
        .manage(WatermarkJobState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init());

    #[cfg(desktop)]
    let builder = builder
        .menu(|app| {
            let menu = Menu::default(app)?;
            let choose_source = MenuItem::with_id(
                app,
                "command.choose-source",
                "选择来源…",
                true,
                Some("CmdOrCtrl+O"),
            )?;
            let choose_auxiliary = MenuItem::with_id(
                app,
                "command.choose-auxiliary",
                "选择辅助目录…",
                true,
                Some("CmdOrCtrl+Shift+O"),
            )?;
            let export = MenuItem::with_id(
                app,
                "command.export",
                "导出结果…",
                true,
                Some("CmdOrCtrl+E"),
            )?;
            let file_separator = PredefinedMenuItem::separator(app)?;
            if let Some(file_item) = menu.get("File") {
                if let Some(file_menu) = file_item.as_submenu() {
                    file_menu.insert_items(
                        &[&choose_source, &choose_auxiliary, &file_separator, &export],
                        0,
                    )?;
                }
            }

            let toggle_log = MenuItem::with_id(
                app,
                "command.toggle-log",
                "显示或隐藏运行日志",
                true,
                Some("CmdOrCtrl+Shift+L"),
            )?;
            let view_separator = PredefinedMenuItem::separator(app)?;
            if let Some(view_item) = menu.get("View") {
                if let Some(view_menu) = view_item.as_submenu() {
                    view_menu.insert_items(&[&toggle_log, &view_separator], 0)?;
                }
            }

            let matcher = MenuItem::with_id(
                app,
                "workspace.matcher",
                "图片 / RAW 匹配",
                true,
                Some("CmdOrCtrl+1"),
            )?;
            let separator = MenuItem::with_id(
                app,
                "workspace.separator",
                "一键分离",
                true,
                Some("CmdOrCtrl+2"),
            )?;
            let watermark = MenuItem::with_id(
                app,
                "workspace.watermark",
                "图片水印",
                true,
                Some("CmdOrCtrl+3"),
            )?;
            let workspace =
                Submenu::with_items(app, "工作区", true, &[&matcher, &separator, &watermark])?;
            menu.insert(&workspace, 4)?;
            Ok(menu)
        })
        .on_menu_event(|app, event| {
            let workspace = match event.id().as_ref() {
                "workspace.matcher" => Some("matcher"),
                "workspace.separator" => Some("separator"),
                "workspace.watermark" => Some("watermark"),
                _ => None,
            };
            if let Some(workspace) = workspace {
                let _ = app.emit("workspace-menu-select", workspace);
                return;
            }

            let command = match event.id().as_ref() {
                "command.choose-source" => Some("choose-source"),
                "command.choose-auxiliary" => Some("choose-auxiliary"),
                "command.export" => Some("export"),
                "command.toggle-log" => Some("toggle-log"),
                _ => None,
            };
            if let Some(command) = command {
                let _ = app.emit("workspace-command", command);
            }
        });

    builder
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
