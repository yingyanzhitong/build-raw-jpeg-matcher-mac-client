## ADDED Requirements

### Requirement: Secure token generation
管理后台 MUST 生成带 `RJM-` 前缀的高熵 Crockford Base32 token，并 MUST 只在创建响应中返回一次明文。

#### Scenario: Administrator creates a batch
- **WHEN** 已认证管理员提交数量和备注
- **THEN** 服务创建对应数量的许可证并提供一次性复制和 CSV 导出

#### Scenario: Storage is inspected
- **WHEN** 管理员或审计程序读取 EdgeOne Blob
- **THEN** 存储仅包含 token 的 HMAC 摘要、末四位和备注，不包含明文 token

### Requirement: Administrator password authentication
所有 `/admin/*` 页面和 API MUST 由 EdgeOne Node.js 云函数管理员会话保护。管理员密码 MUST 只以加盐 PBKDF2-SHA-256 哈希存入 Blob，登录会话 MUST 使用不可预测 token、绝对到期时间、强一致读写和安全 Cookie。

#### Scenario: Missing or forged session
- **WHEN** 请求没有有效的管理员会话 Cookie
- **THEN** 服务返回 401 且不查询或修改许可证数据

#### Scenario: Wrong password or brute-force login
- **WHEN** 账号密码错误或登录请求超过限流阈值
- **THEN** Worker 不创建会话并返回统一凭据错误或 `RATE_LIMITED`

#### Scenario: Administrator logs out
- **WHEN** 管理员主动退出登录
- **THEN** 服务立即删除 Blob 会话并清除浏览器 Cookie

### Requirement: License search and audit
管理后台 MUST 支持按状态、末四位和备注分页查询许可证，并 MUST 展示不泄露完整设备哈希的审计事件。

#### Scenario: Administrator searches licenses
- **WHEN** 管理员输入筛选条件
- **THEN** 后台返回匹配的许可证状态、绑定摘要、激活和续签时间

#### Scenario: Sensitive values are logged
- **WHEN** 服务记录结构化调用日志或审计事件
- **THEN** 日志不包含明文 token、原始设备标识或完整设备哈希

### Requirement: Revocation
管理员 MUST 能撤销许可证，撤销后的 token MUST NOT 激活或续签。

#### Scenario: Revoked token activates
- **WHEN** 客户端使用已撤销 token 请求激活
- **THEN** 服务返回 `REVOKED`

#### Scenario: Revoked lease renews
- **WHEN** 已绑定设备使用被撤销许可证请求续签
- **THEN** 服务返回 `REVOKED` 且不签发新租约

### Requirement: Manual device reset
管理员 MUST 能解除设备绑定并递增许可证代次，原 token MUST 能绑定新设备，旧租约 MUST 不能再续签。

#### Scenario: Administrator resets a binding
- **WHEN** 管理员确认重置已绑定许可证
- **THEN** 服务清空设备绑定、递增代次并记录管理员账号和审计事件

#### Scenario: Old device renews after reset
- **WHEN** 旧设备使用上一代租约请求续签
- **THEN** 服务返回 `LICENSE_EXPIRED`

### Requirement: Stable public API errors
激活和续签 API MUST 使用稳定错误码 `INVALID_TOKEN`、`ALREADY_BOUND`、`REVOKED`、`RATE_LIMITED`、`LICENSE_EXPIRED` 和 `SERVER_ERROR`。

#### Scenario: API failure is rendered by the client
- **WHEN** 服务返回已定义错误码
- **THEN** 客户端显示对应的简体中文恢复指引而不是原始服务异常
