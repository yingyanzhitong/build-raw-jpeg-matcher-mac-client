## ADDED Requirements

### Requirement: 支持拖拽或手动选择 JPEG 文件/目录作为输入
系统必须允许用户通过拖拽或点击选择的方式，将一个或多个文件或目录加入 JPEG 输入。

#### Scenario: 拖入多个 JPEG 文件
- **WHEN** 用户将多个 `.jpg` 或 `.jpeg` 文件拖入 JPEG 输入区域
- **THEN** 系统记录所有被拖入的 JPEG 文件作为输入候选

#### Scenario: 手动选择多个 JPEG 文件
- **WHEN** 用户点击 JPG 输入区域或选择 JPG 文件入口，并在文件选择器中选择多个 `.jpg` 或 `.jpeg` 文件
- **THEN** 系统记录所有被选择的 JPEG 文件作为输入候选

#### Scenario: 递归扫描拖入的 JPEG 目录
- **WHEN** 用户拖入一个包含多层子目录且子目录中存在 JPEG 文件的目录
- **THEN** 系统递归扫描该目录，并记录每一个 `.jpg` 或 `.jpeg` 文件作为输入候选

#### Scenario: 手动选择多个 JPEG 目录
- **WHEN** 用户点击选择 JPG 目录入口，并在目录选择器中选择一个或多个目录
- **THEN** 系统递归扫描这些目录，并记录每一个 `.jpg` 或 `.jpeg` 文件作为输入候选

#### Scenario: 拖入非 JPEG 文件
- **WHEN** 用户拖入不是 `.jpg` 或 `.jpeg` 的文件
- **THEN** 系统忽略这些文件，并在日志中记录已跳过不支持的输入

### Requirement: JPEG 输入列表去重
系统必须防止同一个 JPEG 文件路径在当前输入列表中出现多次。

#### Scenario: 重复添加同一个 JPEG
- **WHEN** 用户拖入一个已经存在于当前输入列表中的 JPEG 文件
- **THEN** 系统只保留该 JPEG 的一条记录，并在日志中记录已跳过重复输入

### Requirement: 支持选择 RAW 源目录
系统必须允许用户在 GUI 中选择且仅选择一个 RAW 源目录。

#### Scenario: 选择 RAW 目录
- **WHEN** 用户通过 RAW 源目录选择器选择一个目录
- **THEN** 系统将该目录保存为 RAW 源根目录，并在 GUI 中展示其路径

#### Scenario: 取消 RAW 目录选择
- **WHEN** 用户打开 RAW 源目录选择器后取消对话框
- **THEN** 系统保持之前的 RAW 源目录不变

### Requirement: 查找操作必须具备 JPEG 输入和 RAW 源目录
系统必须在至少存在一个 JPEG 输入且已选择 RAW 源目录后，才允许执行查找操作。

#### Scenario: 缺少必要输入时尝试查找
- **WHEN** 用户尚未同时提供 JPEG 输入和 RAW 源目录
- **THEN** 系统禁用查找操作，或展示校验提示说明缺少哪些内容
