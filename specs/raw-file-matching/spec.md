## ADDED Requirements

### Requirement: 递归扫描 RAW 源目录
系统必须递归扫描用户选择的 RAW 源目录，以查找受支持的 RAW 文件。

#### Scenario: 嵌套目录中存在 RAW 文件
- **WHEN** 用户对包含多层子目录的 RAW 源目录执行查找
- **THEN** 系统将所有嵌套目录中的受支持 RAW 文件纳入候选集合

#### Scenario: RAW 源目录中存在不支持的文件
- **WHEN** RAW 源目录中包含不受支持的文件类型
- **THEN** 系统将这些文件排除在匹配之外，并且不将其视为候选 RAW 文件

### Requirement: 按受支持扩展名筛选 RAW 格式
系统必须将 `.cr2`、`.cr3`、`.nef`、`.arw`、`.raf`、`.orf`、`.rw2`、`.dng`、`.rwl`、`.pef`、`.3fr` 和 `.iiq` 视为受支持的 RAW 扩展名，并且扩展名匹配不区分大小写。

#### Scenario: RAW 扩展名大小写不一致
- **WHEN** RAW 源目录包含 `IMG_1001.CR3`、`IMG_1002.cr3` 或 `IMG_1003.ArW` 这类文件
- **THEN** 系统将这些文件都识别为受支持的 RAW 候选文件

### Requirement: 使用精确主文件名匹配
系统必须仅在 JPEG 与 RAW 的去扩展名文件名完全一致时，才将它们视为匹配。

#### Scenario: 存在相同主文件名
- **WHEN** 输入中存在 `IMG_1234.JPG`，且 RAW 源目录中存在 `IMG_1234.CR3`
- **THEN** 系统将 `IMG_1234.CR3` 报告为匹配的 RAW 文件

#### Scenario: JPEG 文件名包含编辑后缀
- **WHEN** 输入中存在 `IMG_1234-Edit.JPG`，且 RAW 源目录中存在 `IMG_1234.CR3`
- **THEN** 系统不匹配这两个文件，除非存在主文件名精确为 `IMG_1234-Edit` 的 RAW 文件，否则将该 JPEG 报告为未找到

### Requirement: 为每个 JPEG 生成明确匹配状态
系统必须为每个 JPEG 输入生成一个结果状态：`matched`、`missing`、`conflict` 或 `confirmed`。

#### Scenario: 找到一个 RAW 候选
- **WHEN** 恰好有一个 RAW 候选文件与某个 JPEG 输入拥有相同主文件名
- **THEN** 系统将该 JPEG 结果标记为 `matched`

#### Scenario: 未找到 RAW 候选
- **WHEN** 没有任何 RAW 候选文件与某个 JPEG 输入拥有相同主文件名
- **THEN** 系统将该 JPEG 结果标记为 `missing`

#### Scenario: 找到多个 RAW 候选
- **WHEN** 多个 RAW 候选文件与某个 JPEG 输入拥有相同主文件名
- **THEN** 系统将该 JPEG 结果标记为 `conflict`，并且不自动选择 RAW 文件

### Requirement: 记录查找进度和摘要
系统必须记录查找进度，并在结束时输出包含输入数量、已匹配数量、未找到数量和冲突数量的摘要。

#### Scenario: 查找完成
- **WHEN** 查找操作完成
- **THEN** 系统在日志中展示各类结果状态的数量摘要
