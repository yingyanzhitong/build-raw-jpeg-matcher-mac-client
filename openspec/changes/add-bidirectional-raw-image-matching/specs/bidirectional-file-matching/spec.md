## ADDED Requirements

### Requirement: 系统按方向递归收集候选文件
系统 MUST在当前方向的查找目录及其子目录中递归收集候选文件：“图片 → RAW”只收集已启用 RAW 格式，“RAW → 图片”只收集 JPG、JPEG 和 PNG；扫描必须跳过已知的 macOS 元数据目录。

#### Scenario: 图片输入查找 RAW
- **WHEN** 用户在“图片 → RAW”方向执行匹配
- **THEN** 系统递归扫描 RAW 查找目录，并仅将当前已启用格式且通过 RAW 文件校验的文件作为候选

#### Scenario: RAW 输入查找图片
- **WHEN** 用户在“RAW → 图片”方向执行匹配
- **THEN** 系统递归扫描图片查找目录，并将 JPG、JPEG 和 PNG 文件作为候选

#### Scenario: 扫描 macOS 元数据目录
- **WHEN** 查找目录包含 .Spotlight-V100、.Trashes、.fseventsd 或 .TemporaryItems
- **THEN** 系统跳过这些目录及其内容

### Requirement: RAW 校验规则只作用于 RAW 文件
系统 MUST在 RAW 处于输入侧或候选侧时应用相同的受支持格式和最小文件大小校验，不得将 RAW 的最小文件大小规则应用于 JPG、JPEG 或 PNG。

#### Scenario: 扫描过小 RAW 文件
- **WHEN** 系统发现小于既定 RAW 最小文件大小的 RAW 文件
- **THEN** 系统跳过该 RAW 文件并在当前方向日志中记录

#### Scenario: 扫描小尺寸图片文件
- **WHEN** 系统发现文件大小低于 RAW 最小文件大小但扩展名为受支持图片格式的文件
- **THEN** 系统不得仅因 RAW 大小阈值而跳过该图片

### Requirement: 物理文件使用精确主文件名匹配
系统 MUST仅在输入文件与候选文件去除扩展名后的主文件名大小写及字符完全一致时建立物理文件匹配，不得自动删除编辑后缀或执行模糊匹配。

#### Scenario: 图片与 RAW 主文件名一致
- **WHEN** 输入为 IMG_1234.JPG 且候选为 IMG_1234.CR3
- **THEN** 系统将两者视为同名候选

#### Scenario: RAW 与图片主文件名一致
- **WHEN** 输入为 IMG_1234.CR3 且候选为 IMG_1234.PNG
- **THEN** 系统将两者视为同名候选

#### Scenario: 主文件名大小写不同
- **WHEN** 输入主文件名为 IMG_1234 且候选主文件名为 img_1234
- **THEN** 系统不得将两者视为精确同名

#### Scenario: 图片包含编辑后缀
- **WHEN** 输入为 IMG_1234-Edit.JPG 且候选仅有 IMG_1234.CR3
- **THEN** 系统将该输入标记为未找到

### Requirement: 手工输入引用保留后缀查找行为
系统 MUST先按完整主文件名匹配两个方向的手工文本引用；没有精确候选时，必须使用不区分大小写的主文件名后缀查找当前方向的候选。RAW 文本引用带扩展名时必须属于当前已启用格式。

#### Scenario: 手工引用精确匹配
- **WHEN** 手工引用为 5N6A5022.JPG 且存在 5N6A5022.CR3
- **THEN** 系统使用精确主文件名候选

#### Scenario: 手工引用使用末尾编号
- **WHEN** 手工引用为 5022 且存在 5N6A5022.CR3
- **THEN** 系统将该 RAW 文件纳入候选

#### Scenario: RAW 手工引用查找图片
- **WHEN** 手工 RAW 引用为 `5N6A5022.CR3` 或 `5022`，且图片查找目录中存在 `5N6A5022.PNG`
- **THEN** 系统将该图片纳入候选，并将文本引用作为无本地路径的 RAW 输入展示

### Requirement: 系统为每个输入生成统一匹配状态
系统 MUST为每个输入生成 matched、missing、conflict 或 confirmed 状态，并按当前方向保存候选文件及唯一已选候选。

#### Scenario: 没有候选
- **WHEN** 某个输入没有同名候选
- **THEN** 系统将结果标记为 missing

#### Scenario: 恰好一个候选
- **WHEN** 某个输入恰好有一个同名候选
- **THEN** 系统将结果标记为 matched 并自动选择该候选

#### Scenario: 多个 RAW 候选
- **WHEN** 图片输入对应多个同名 RAW 候选
- **THEN** 系统将结果标记为 conflict 且不自动选择候选

#### Scenario: 多个图片候选
- **WHEN** RAW 输入对应跨目录或跨 JPG、JPEG、PNG 格式的多个同名图片候选
- **THEN** 系统将结果标记为 conflict 且不自动选择候选

### Requirement: 匹配条件变化必须使旧结果失效
系统 MUST在当前方向的输入、查找目录或 RAW 格式发生变化时清除该方向的旧结果、冲突确认和导出报告；不得导出基于旧条件生成的候选。

#### Scenario: 更换查找目录
- **WHEN** 当前方向已有结果且用户更换查找目录
- **THEN** 系统立即清除该方向的结果、确认项和导出报告

#### Scenario: 修改输入或 RAW 格式
- **WHEN** 当前方向已有结果且用户增加、移除输入或修改 RAW 格式
- **THEN** 系统立即清除该方向的结果、确认项和导出报告

### Requirement: 匹配过程提供方向化日志与摘要
系统 MUST记录输入收集、候选扫描、跳过项、匹配、缺失和冲突，并在结束时为当前方向展示输入数、已匹配数、未找到数、冲突数和已确认数。

#### Scenario: 图片找 RAW 完成
- **WHEN** “图片 → RAW”匹配结束
- **THEN** 日志和摘要使用图片输入与 RAW 候选语义报告结果

#### Scenario: RAW 找图片完成
- **WHEN** “RAW → 图片”匹配结束
- **THEN** 日志和摘要使用 RAW 输入与图片候选语义报告结果
