## ADDED Requirements

### Requirement: 三个工作区统一显示导出结果 Toast
系统 MUST 在图片 / RAW 匹配、一键分离和图片水印的导出任务返回结果后显示统一样式的 Toast，并在文案中给出当前功能最关键的成功、跳过或失败数量。

#### Scenario: 匹配文件全部导出成功
- **WHEN** 匹配导出调用完成且 `sourceErrorCount` 为 0
- **THEN** 系统显示成功 Toast，并保留现有导出详情弹窗

#### Scenario: 一键分离全部成功
- **WHEN** 分离导出调用完成且 `failedCount` 为 0
- **THEN** 系统显示成功 Toast，并保留现有页脚结果报告

#### Scenario: 水印全部导出成功
- **WHEN** 水印导出调用完成且 `failedCount` 与 `cancelledRemainingCount` 都为 0
- **THEN** 系统显示成功 Toast，并保留现有页脚结果报告

#### Scenario: 水印任务被取消
- **WHEN** 水印导出调用完成且没有失败项但存在 `cancelledRemainingCount`
- **THEN** 系统显示警告 Toast，文案包含已导出和未处理数量

### Requirement: 导出失败自动展开运行日志
系统 MUST 在任一导出汇总包含实际失败项，或导出调用抛出异常时，显示失败 Toast 并自动展开当前工作区的底部运行日志。

#### Scenario: 导出结果部分失败
- **WHEN** 匹配的 `sourceErrorCount`、分离的 `failedCount` 或水印的 `failedCount` 大于 0
- **THEN** 系统显示失败 Toast，并自动展开包含逐项失败信息的底部日志

#### Scenario: 导出调用整体失败
- **WHEN** 任一工作区的导出 IPC 调用抛出异常
- **THEN** 系统把异常写入当前工作区日志、显示失败 Toast，并自动展开底部日志

### Requirement: Toast 生命周期与无障碍反馈
系统 SHALL 只显示最新一条导出结果 Toast，使用与结果级别匹配的图标和颜色，并通过无障碍实时区域播报；Toast MUST 在限定时间后自动消失且不得阻挡用户操作。

#### Scenario: 连续收到两个导出反馈
- **WHEN** 新反馈在旧 Toast 自动消失前到达
- **THEN** 系统立即用新反馈替换旧 Toast，旧计时器不得关闭新 Toast

#### Scenario: 失败 Toast 展示
- **WHEN** 系统显示失败 Toast
- **THEN** Toast 使用警报语义且保持足够时间供用户识别，同时底部日志已自动展开

### Requirement: 底部日志以 tail 方式展示最新记录
系统 MUST 在底部运行日志打开时自动滚动到最后一条记录；面板保持打开且有新日志到达时，系统 MUST 继续滚动到最新记录，同时保留日志从旧到新的渲染顺序。

#### Scenario: 打开已有日志的面板
- **WHEN** 用户手动打开日志面板，或导出失败触发自动展开
- **THEN** 日志视口定位到最后一条记录，使最新状态或错误立即可见

#### Scenario: 运行期间持续产生日志
- **WHEN** 日志面板已打开且任务追加一条或多条新日志
- **THEN** 日志视口自动跟随到新的最后一条记录
