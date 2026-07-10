## ADDED Requirements

### Requirement: 冲突结果必须视觉高亮
系统 MUST在两个方向中以状态文字、图标和视觉样式区分 conflict 结果，不得只依赖颜色表达冲突。

#### Scenario: 展示 RAW 候选冲突
- **WHEN** 图片输入存在多个同名 RAW 候选
- **THEN** 结果行显示“需复核”状态及可识别的冲突样式

#### Scenario: 展示图片候选冲突
- **WHEN** RAW 输入存在多个同名图片候选
- **THEN** 结果行显示“需复核”状态及可识别的冲突样式

### Requirement: 用户可以打开方向化冲突复核
系统 MUST允许用户从 conflict 结果打开复核弹窗；弹窗左侧展示当前输入，右侧展示当前方向的全部候选。

#### Scenario: 复核图片找 RAW 冲突
- **WHEN** 用户打开“图片 → RAW”方向的冲突结果
- **THEN** 弹窗左侧展示图片输入或手工引用，右侧展示所有 RAW 候选

#### Scenario: 复核 RAW 找图片冲突
- **WHEN** 用户打开“RAW → 图片”方向的冲突结果
- **THEN** 弹窗左侧展示 RAW 输入，右侧展示所有 JPG、JPEG 和 PNG 候选

### Requirement: 冲突弹窗展示候选信息与预览
系统 MUST为每个候选展示文件名、路径、扩展名、大小和修改时间；RAW 文件使用 Quick Look 缩略图能力，图片文件直接展示图片预览。

#### Scenario: 展示 RAW 文件
- **WHEN** 冲突弹窗中的输入或候选是 RAW 文件
- **THEN** 系统展示 RAW 元信息，并在可生成时展示 Quick Look 缩略图

#### Scenario: 展示图片文件
- **WHEN** 冲突弹窗中的输入或候选是 JPG、JPEG 或 PNG
- **THEN** 系统展示图片元信息和直接图片预览

#### Scenario: 展示手工图片引用
- **WHEN** 冲突输入来自文本清单且没有真实文件路径
- **THEN** 系统展示引用内容，但不得提供打开或预览不存在原文件的操作

### Requirement: 用户必须确认唯一候选
系统 MUST允许用户在冲突候选中选择且仅选择一个文件；确认后必须保存该候选并将结果状态变为 confirmed。

#### Scenario: 确认一个 RAW 候选
- **WHEN** 用户在图片找 RAW 冲突中选择一个 RAW 并确认
- **THEN** 系统保存该 RAW 为唯一已选候选并将结果标记为 confirmed

#### Scenario: 确认一个图片候选
- **WHEN** 用户在 RAW 找图片冲突中选择一个 JPG、JPEG 或 PNG 并确认
- **THEN** 系统保存该图片为唯一已选候选并将结果标记为 confirmed

#### Scenario: 未选择候选
- **WHEN** 用户尚未选择任何候选
- **THEN** 系统禁用确认操作

### Requirement: 用户可以打开真实输入和候选文件
系统 MUST允许用户通过明确的打开操作，使用 macOS 默认关联应用打开具有真实路径的输入或候选文件。

#### Scenario: 打开 RAW 文件
- **WHEN** 用户请求打开具有真实路径的 RAW 输入或候选
- **THEN** 系统请求 macOS 使用默认关联应用打开该 RAW 文件

#### Scenario: 打开图片文件
- **WHEN** 用户请求打开具有真实路径的图片输入或候选
- **THEN** 系统请求 macOS 使用默认关联应用打开该图片文件

### Requirement: 冲突确认必须跟随匹配结果生命周期
系统 MUST将确认项保存于产生它的方向和匹配结果中；当前方向的匹配条件变化或重新执行匹配时必须清除旧确认，切换方向时则保留并恢复各自确认。

#### Scenario: 修改匹配条件
- **WHEN** 用户修改当前方向输入、查找目录或 RAW 格式
- **THEN** 系统清除该方向旧匹配结果中的所有确认

#### Scenario: 切换方向后返回
- **WHEN** 用户切换到另一方向后再返回
- **THEN** 系统恢复该方向仍然有效的冲突确认状态
