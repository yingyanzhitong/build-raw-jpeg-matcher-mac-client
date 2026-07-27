## ADDED Requirements

### Requirement: Stable platform device identity
激活版 MUST 在 macOS 使用 `IOPlatformUUID`、在 Windows 使用 `MachineGuid` 形成稳定设备身份，并且 MUST 只向服务端传输带产品域隔离的 SHA-256 哈希。

#### Scenario: Same computer is identified after reinstall
- **WHEN** 用户在未更换系统设备标识的同一电脑重新安装激活版
- **THEN** 客户端生成与首次激活相同的设备哈希

#### Scenario: Raw identifier remains local
- **WHEN** 客户端构造激活或续签请求
- **THEN** 请求、日志和本地许可证均不包含原始平台设备标识

### Requirement: First-run activation gate
激活版 MUST 在许可证检查完成前阻止业务工作区加载，并 MUST 在没有有效租约时提供 token 激活、设备码复制和激活版更新检查。

#### Scenario: Fresh install requires a token
- **WHEN** 用户首次启动且系统凭据库没有有效租约
- **THEN** 应用显示激活门且不显示或执行业务工作区

#### Scenario: Valid local lease opens the workspace
- **WHEN** 系统凭据库中的租约签名、产品、设备和有效期均合法
- **THEN** 应用进入业务工作区并在需要时后台续签

### Requirement: Signed device lease
EdgeOne 服务 MUST 使用独立 Ed25519 私钥签署包含许可证、产品、设备、代次和时间边界的租约，客户端 MUST 在解析和使用前验证签名。

#### Scenario: Tampered lease is rejected
- **WHEN** 租约内容或签名任意一处被修改
- **THEN** 客户端拒绝该租约并保持业务命令锁定

#### Scenario: Lease cannot move to another device
- **WHEN** 有效签名租约中的设备哈希与当前电脑不一致
- **THEN** 客户端拒绝该租约

### Requirement: One-device activation
服务 MUST 将每个有效 token 绑定到最多一个设备哈希，并 MUST 允许同一设备幂等地重新激活。当前 EdgeOne Blob 实现 MUST 使用强一致读取、条件写、竞争稳定窗口和 nonce 回读降低并发覆盖风险，并 MUST 明确其不等同于数据库事务或 CAS。

#### Scenario: First device wins
- **WHEN** 未绑定 token 收到合法的首次激活请求
- **THEN** 服务保存设备绑定、强一致回读确认当前设备获胜后返回签名租约

#### Scenario: Second device is rejected
- **WHEN** 已绑定 token 被不同设备提交
- **THEN** 服务返回 `ALREADY_BOUND` 且不修改原绑定

#### Scenario: Concurrent devices are settled
- **WHEN** 两个不同设备并发提交同一个未绑定 token
- **THEN** 服务在竞争稳定窗口后回读获胜 nonce，验收测试 MUST 观察到最多一个请求成功，另一个返回 `ALREADY_BOUND`

#### Scenario: Eventually consistent storage is available
- **WHEN** EdgeOne KV 与 Blob 均可供服务选择
- **THEN** 服务 MUST 使用 Blob `onlyIfNew` 条件写和强一致回读保存设备绑定，不得使用最终一致 KV 作为授权真相源

#### Scenario: Transactional guarantee is required
- **WHEN** 业务要求任意网络暂停和跨区域调度下严格线性化的一机一码
- **THEN** 服务 MUST 改用支持事务或 CAS 的存储，不得把当前 Blob 竞争收敛描述为数据库级原子保证

### Requirement: Rolling offline lease
客户端 MUST 支持 30 天有效租约和额外 7 天离线宽限，并 MUST 在上次在线检查超过 24 小时后尝试后台续签。

#### Scenario: Network failure inside grace period
- **WHEN** 续签请求因网络失败且当前时间不晚于 `grace_until`
- **THEN** 客户端继续开放业务功能并明确显示离线宽限状态

#### Scenario: Grace period expires
- **WHEN** 当前可信时间晚于 `grace_until`
- **THEN** 客户端阻断业务功能并要求联网续签

#### Scenario: Server revokes an online device
- **WHEN** 续签接口明确返回 `REVOKED`
- **THEN** 客户端立即阻断业务功能，不使用剩余本地租约兜底

### Requirement: Protected local credential storage
客户端 MUST 将签名租约和可信时间存入 macOS Keychain 或 Windows Credential Manager，且 MUST NOT 持久化明文 token。

#### Scenario: Activation succeeds
- **WHEN** 服务返回有效签名租约
- **THEN** 客户端只持久化租约、签名和可信时间并清除内存中的 token

#### Scenario: Credential storage is unavailable
- **WHEN** 系统凭据库读取或写入失败
- **THEN** 客户端显示可操作错误且不回退到普通文件或 localStorage

### Requirement: Rust command enforcement
激活版所有业务 Tauri 命令 MUST 在执行读取、写入或启动后台任务前验证许可证状态。

#### Scenario: Frontend gate is bypassed
- **WHEN** 未激活调用者直接调用任一业务 Tauri 命令
- **THEN** Rust 返回未授权错误且不产生文件系统或任务副作用

#### Scenario: License commands remain available
- **WHEN** 应用尚未激活
- **THEN** 许可证状态、激活、续签和设备码命令仍可调用
