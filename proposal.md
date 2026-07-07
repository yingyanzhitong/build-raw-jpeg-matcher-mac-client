## Why

摄影师经常会收到客户挑选好的 JPEG 文件，然后需要在大量 RAW 原片中手动找到对应文件再进入修图流程。一个轻量的 macOS 桌面客户端可以把这个重复、容易出错的文件查找工作变成可视化批处理流程。

## What Changes

- 新增一个基于 Tauri 的 macOS 桌面客户端，用于根据客户选择的 JPEG 文件匹配本地 RAW 文件。
- 提供上下两部分 GUI：
  - 上半部分：左侧支持拖入 JPEG 文件或目录，右侧选择 RAW 源目录。
  - 下半部分：展示操作按钮、匹配/导出状态、冲突提示和日志。
- 对拖入的 JPEG 目录和选择的 RAW 目录进行递归扫描。
- 仅按去扩展名后的精确文件名匹配 RAW 候选，扩展名大小写不敏感。
- 将已匹配或用户手动确认的 RAW 文件导出到同一个目标文件夹。
- 当一个 JPEG 对应多个 RAW 候选时标记为冲突，不自动选择。
- 提供冲突复核弹窗：左侧展示 JPEG，右侧展示多个 RAW 候选；双击条目可打开原始文件查看。

## Capabilities

### New Capabilities

- `photo-source-selection`：覆盖通过拖拽选择 JPEG 输入，以及在 GUI 中选择 RAW 源目录。
- `raw-file-matching`：覆盖递归扫描、精确同名匹配、匹配状态计算、冲突检测和日志记录。
- `raw-export-workflow`：覆盖选择导出目标、将选中的 RAW 文件复制到同一个文件夹、冲突阻止导出行为和导出日志。
- `raw-conflict-review`：覆盖展示歧义 RAW 匹配、查看候选文件、打开原始文件，以及记录用户手动选择的 RAW。

### Modified Capabilities

无。

## Impact

- 新增一个 Tauri macOS 桌面应用，使用 Web 前端和 Rust 后端命令。
- 新增本地图片目录的文件系统扫描和复制逻辑。
- 新增输入、匹配结果、冲突复核、导出进度和日志相关 UI 状态。
- 依赖可能包括 Tauri v2、React/Vite/TypeScript 等前端栈、Tauri 官方 dialog/opener 插件，以及 Rust 侧文件系统/路径处理能力。
