## ADDED Requirements

### Requirement: Secure token generation
管理后台 MUST 生成带 `RJM-` 前缀的高熵 Crockford Base32 token，并 MUST 只在创建响应中返回一次明文。

#### Scenario: Administrator creates a batch
- **WHEN** 已认证管理员提交数量和备注
- **THEN** 服务创建对应数量的许可证并提供一次性复制和 CSV 导出

#### Scenario: Database is inspected
- **WHEN** 管理员或审计程序读取 D1
- **THEN** 数据库仅包含 token 的 HMAC 摘要、末四位和备注，不包含明文 token

### Requirement: Cloudflare Access administrator authentication
所有 `/admin/*` 页面和 API MUST 同时受 Cloudflare Access 策略和 Worker 内 Access JWT 验证保护。

#### Scenario: Missing Access assertion
- **WHEN** 请求没有 `Cf-Access-Jwt-Assertion`
- **THEN** Worker 返回 403 且不查询或修改许可证数据

#### Scenario: Forged or wrong-audience assertion
- **WHEN** JWT 签名、issuer、audience 或管理员邮箱不匹配
- **THEN** Worker 返回 403

### Requirement: License search and audit
管理后台 MUST 支持按状态、末四位和备注分页查询许可证，并 MUST 展示不泄露完整设备哈希的审计事件。

#### Scenario: Administrator searches licenses
- **WHEN** 管理员输入筛选条件
- **THEN** 后台返回匹配的许可证状态、绑定摘要、激活和续签时间

#### Scenario: Sensitive values are logged
- **WHEN** Worker 记录结构化调用日志或审计事件
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
- **THEN** 服务清空设备绑定、递增代次并记录管理员邮箱和审计事件

#### Scenario: Old device renews after reset
- **WHEN** 旧设备使用上一代租约请求续签
- **THEN** 服务返回 `LICENSE_EXPIRED`

### Requirement: Stable public API errors
激活和续签 API MUST 使用稳定错误码 `INVALID_TOKEN`、`ALREADY_BOUND`、`REVOKED`、`RATE_LIMITED`、`LICENSE_EXPIRED` 和 `SERVER_ERROR`。

#### Scenario: API failure is rendered by the client
- **WHEN** 服务返回已定义错误码
- **THEN** 客户端显示对应的简体中文恢复指引而不是原始服务异常
