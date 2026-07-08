## ADDED Requirements

### Requirement: 主界面必须提供工作区 Tab
系统 SHALL 在应用标题区下方提供工作区 Tab 栏，用于在 `RAW/JPEG matcher` 和 `添加水印` 两个工作区之间切换。

#### Scenario: 默认打开 RAW/JPEG matcher
- **WHEN** 用户启动应用
- **THEN** 系统默认选中 `RAW/JPEG matcher` Tab 并展示现有 RAW/JPEG 匹配工作区

#### Scenario: 切换到添加水印
- **WHEN** 用户点击 `添加水印` Tab
- **THEN** 系统展示水印工作区并隐藏 RAW/JPEG 匹配工作区

### Requirement: 工作区状态必须相互隔离
系统 SHALL 隔离 RAW/JPEG 匹配工作区和水印工作区的输入、结果、统计和日志状态。

#### Scenario: 切换 Tab 不清空 RAW/JPEG 状态
- **WHEN** 用户已在 `RAW/JPEG matcher` 中加入 JPEG 输入并切换到 `添加水印` 后再切回
- **THEN** 系统保留原有 JPEG 输入、RAW 源目录、匹配结果和日志

#### Scenario: 水印日志不写入 RAW/JPEG 日志
- **WHEN** 用户在 `添加水印` 工作区执行图片扫描或导出
- **THEN** 系统只更新水印工作区的日志和统计，不修改 RAW/JPEG 匹配工作区的日志和统计
