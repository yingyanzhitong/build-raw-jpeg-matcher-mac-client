## ADDED Requirements

### Requirement: 冲突结果需要视觉高亮
系统必须在视觉上区分 `conflict` 匹配结果与普通的已匹配、未找到结果。

#### Scenario: 展示冲突行
- **WHEN** 某个 JPEG 结果存在多个 RAW 候选
- **THEN** GUI 中对应结果行以红色冲突状态标记

### Requirement: 点击冲突行打开复核弹窗
系统必须在用户选择冲突匹配结果时打开冲突复核弹窗。

#### Scenario: 用户点击冲突行
- **WHEN** 用户点击一个标记为 `conflict` 的结果行
- **THEN** 系统打开用于解决该 JPEG 的 RAW 候选冲突的专用弹窗

### Requirement: 冲突弹窗展示 JPEG 和 RAW 候选
冲突复核弹窗必须在左侧展示 JPEG 输入，在右侧展示所有匹配到的 RAW 候选。

#### Scenario: 展示冲突弹窗
- **WHEN** 冲突复核弹窗打开
- **THEN** 左侧展示 JPEG 文件信息，并在可用时展示预览；右侧展示每个 RAW 候选的文件名、路径、扩展名、大小和修改时间

### Requirement: 用户可以确认一个 RAW 候选
冲突复核弹窗必须允许用户选择且仅选择一个 RAW 候选作为确认匹配结果。

#### Scenario: 用户确认候选
- **WHEN** 用户选择一个 RAW 候选并确认
- **THEN** 系统为该 JPEG 结果保存选中的 RAW 路径，并将结果状态从 `conflict` 改为 `confirmed`

### Requirement: 可从冲突复核中打开原始文件
冲突复核弹窗必须允许用户使用 macOS 默认应用打开 JPEG 输入或 RAW 候选文件。

#### Scenario: 用户双击 RAW 候选
- **WHEN** 用户在冲突复核弹窗中双击某个 RAW 候选
- **THEN** 系统请求 macOS 使用默认关联应用打开该 RAW 文件

#### Scenario: 用户双击 JPEG 预览
- **WHEN** 用户在冲突复核弹窗中双击 JPEG 区域
- **THEN** 系统请求 macOS 使用默认关联应用打开该 JPEG 文件
