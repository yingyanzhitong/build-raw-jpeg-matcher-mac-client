## Context

现有仓库在公开 `main` 分支构建“照片配对助手”，使用 `vX.Y.Z` GitHub Release、原 Gitee 发行镜像和一套 Tauri updater 签名密钥。客户端业务命令均可直接调用，不存在许可证状态或服务端依赖。

本变更需要在同一公开仓库中维护长期 `licensed` 分支。共享功能只从 `main` 合并到 `licensed`，激活能力和 Cloudflare 服务永不反向进入 `main`。激活版面向 macOS Apple Silicon、macOS Intel 和 Windows x64，必须与旧应用、旧数据目录和旧更新通道并存。

## Goals / Non-Goals

**Goals:**

- 一个随机 token 在服务端最多绑定一个稳定设备哈希，同设备重装可重新获取租约。
- 客户端离线校验服务端 Ed25519 签名租约，业务能力在 Rust 命令层统一拒绝无效许可证。
- 管理员可通过受 Cloudflare Access 保护的网页生成、查询、撤销和重置授权。
- 无激活版与激活版拥有独立分支、版本、应用身份、tag、产物、updater 密钥和 Gitee 清单。
- 通过自动测试和分支不变量检查降低合并 `main` 时破坏鉴权配置的风险。

**Non-Goals:**

- 不接入支付平台、订单回调、自动发货或用户账号体系。
- 不迁移旧应用的本地设置、缓存或工作区状态。
- 不尝试让公开源码不可破解，也不阻止用户继续使用公开无激活版。
- 不要求设备持续在线；撤销对离线设备不能立即生效。

## Decisions

### 长期分支与版本

先在 `main` 将发布工作流改为 `vX.Y.Z` tag 驱动并把发布脚本参数化，再从该提交创建 `licensed`。激活版专属代码只存在于 `licensed`，并以 `tauri.licensed.conf.json` 记录独立 `1.0.0` 版本、产品身份和 updater 配置。这样合并 `main` 时不会覆盖激活版版本，也不需要在 `main` 保留可关闭鉴权的构建开关。

备选方案是在单分支通过环境变量构建两个版本，但公开构建开关容易误发无鉴权产物，且共享配置更容易串线，因此不采用。

### 设备身份与本地存储

macOS 通过 IOKit 获取 `IOPlatformUUID`，Windows 从注册表获取 `MachineGuid`。客户端将标识规范化后计算 `SHA-256("raw-jpeg-matcher-licensed:v1\0" + 标识)`，只向服务端发送十六进制哈希。平台读取封装为可注入 provider，以便单元测试覆盖稳定性和失败路径。

客户端只在激活请求内短暂持有明文 token。服务端返回的签名租约和最近一次可信服务器时间保存在 macOS Keychain 或 Windows Credential Manager。文件、localStorage 和日志不得出现明文 token。

### 签名租约与续签

Cloudflare 使用独立 Ed25519 私钥签署原始 JSON 字节，客户端内置对应公钥并验证签名后再解析。租约字段固定为：

- `schema_version`
- `license_id`
- `product`
- `device_hash`
- `generation`
- `issued_at`
- `renew_after`
- `expires_at`
- `grace_until`

租约有效期为 30 天，`grace_until` 比 `expires_at` 晚 7 天。客户端在上次在线检查超过 24 小时后后台调用续签；网络失败时继续使用本地租约直到宽限结束，服务端明确返回撤销、代次或设备不匹配时立即阻断。客户端保存最近可信时间并对明显系统时间回拨返回阻断状态。

### Rust 命令门禁

Tauri 管理一个共享 `LicenseManager`。许可证命令可在未激活状态调用；所有扫描、匹配、导出、预览、缩略图和打开文件命令在执行副作用前调用统一的 `require_active`。React 激活门只负责用户体验，不构成安全边界。

### Cloudflare 数据和原子绑定

Worker 使用 D1 的 `licenses` 和 `license_events` 表。token 为 `RJM-` 前缀的 Crockford Base32 随机值，数据库只保存 `HMAC-SHA-256(pepper, normalized_token)`、末四位和管理员备注。

首次绑定使用带条件的单条 `UPDATE`，条件包含有效状态以及“未绑定或已绑定同一设备”。更新结果为零时读取当前状态，区分无效、撤销和已绑定其他设备。重置清空设备并递增 `generation`；旧租约不能再续签。每次管理操作和激活结果写入审计事件，但日志不记录明文 token、原始设备标识或完整设备哈希。

### API 与管理员边界

公共 API 为 `POST /api/v1/activate`、`POST /api/v1/renew` 和 `GET /healthz`。请求体执行严格大小、类型和格式校验，并用 Rate Limiting binding 抑制滥用。

管理页面和管理 API 统一放在 `/admin/*`。Cloudflare Access 只允许当前 Cloudflare 账户管理员邮箱使用 OTP 登录；Worker 必须使用 Access JWKS 验证 `Cf-Access-Jwt-Assertion` 的签名、issuer 和 audience 后才访问 D1。

### 发行通道

`vX.Y.Z` 仅允许指向 `main` 可达提交；`licensed-vX.Y.Z` 仅允许指向 `licensed` 可达提交。工作流使用完整 fetch 深度验证可达性和配置版本。

激活版构建通过 Tauri `--config src-tauri/tauri.licensed.conf.json` 合并以下值：

- `productName`: `摄影修图师助手`
- `identifier`: `com.masongzhi.rawjpegmatcher.licensed`
- updater endpoint: 新 Gitee 仓库 `release/latest.json`
- 独立 updater 公钥

激活版资产前缀为 `raw-jpeg-matcher-licensed`，发布到 GitHub `licensed-vX.Y.Z` Release 和公开 Gitee 仓库 `masongzhi1/raw-jpeg-matcher-licensed-release`。许可证签名密钥、激活版 updater 密钥和旧 updater 密钥互不复用。

## Risks / Trade-offs

- [源码和无激活版继续公开，无法防止源码级绕过] → 明确安全边界，仅承诺正常激活版的一机一码、撤销和通道隔离。
- [设备 UUID 在克隆系统或虚拟机中可能重复] → 服务端保留审计与人工重置能力，不宣称硬件不可伪造。
- [离线设备不能立即撤销] → 每 24 小时尝试在线续签，并把最大离线使用窗口固定为 37 天。
- [合并 `main` 可能覆盖激活版文件] → 采用分支专属配置、独立 workflow、必需 CI 不变量测试和禁止反向合并规则。
- [Cloudflare Access 配置错误可能暴露管理接口] → 边缘 Access 与 Worker 内 JWT 验证双重校验，任何缺失或失败均返回 403。
- [密钥丢失会导致无法续签或更新] → 私钥仅存 Cloudflare/GitHub Secrets，并在部署前保存离线备份；公钥提交仓库。

## Migration Plan

1. 在 `main` 参数化发布脚本、切换无激活版 tag 触发、更新版本和变更日志，并验证产物行为不变。
2. 从已验证的 `main` 创建 `licensed`，添加 OpenSpec、客户端鉴权、服务端、管理后台和独立发行配置。
3. 创建 D1、应用 migration、配置 Worker Secrets、Custom Domain 和 Cloudflare Access。
4. 创建公开 Gitee 激活版发行仓库，配置 GitHub Secrets 和分支保护。
5. 使用测试 token 完成双设备激活、拒绝、重置、续签和离线宽限验收。
6. 推送 `licensed-v1.0.0` 后校验 GitHub/Gitee 产物和 `latest.json`，再对外发放 token。

回滚时保留 D1 与密钥，回退 Worker 到上一版本并删除未完成的激活版 tag/Release；`main` 无激活版不受影响。已签发租约在宽限期内仍可离线验证，因此不得通过删除 D1 代替正常回滚。

## Open Questions

无。管理员邮箱从 Cloudflare 当前账户身份读取并作为唯一 Access allowlist。
