## Context

现有仓库在公开 `main` 分支构建“照片配对助手”，使用 `vX.Y.Z` GitHub Release、原 Gitee 发行镜像和一套 Tauri updater 签名密钥。客户端业务命令均可直接调用，不存在许可证状态或服务端依赖。

本变更需要在同一公开仓库中维护长期 `licensed` 分支。共享功能只从 `main` 合并到 `licensed`，激活能力和 EdgeOne 服务永不反向进入 `main`。激活版面向 macOS Apple Silicon、macOS Intel 和 Windows x64，必须与旧应用、旧数据目录和旧更新通道并存。

## Goals / Non-Goals

**Goals:**

- 一个随机 token 在服务端最多绑定一个稳定设备哈希，同设备重装可重新获取租约。
- 客户端离线校验服务端 Ed25519 签名租约，业务能力在 Rust 命令层统一拒绝无效许可证。
- 管理员可通过账号密码登录的网页生成、查询、撤销和重置授权。
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

EdgeOne Node.js 云函数使用独立 Ed25519 私钥签署原始 JSON 字节，客户端内置对应公钥并验证签名后再解析。租约字段固定为：

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

### EdgeOne Blob 数据和设备绑定

EdgeOne Node.js 云函数使用 Blob 保存许可证元数据、token 摘引、设备 claim、审计、管理员与会话。所有授权判断采用强一致读取。token 为 `RJM-` 前缀的 Crockford Base32 随机值，Blob 只保存 `HMAC-SHA-256(pepper, normalized_token)`、末四位和管理员备注。

首次绑定为每个许可证创建独立 claim 对象，先强一致读取，再使用 `onlyIfNew` 条件写，并在 750 毫秒竞争稳定窗口后强一致回读 nonce 确认获胜设备。同设备重复激活幂等，不同设备返回 `ALREADY_BOUND`。重置先递增元数据 `generation` 再删除 claim；旧租约不能再续签。每次管理操作和激活结果写入审计对象，但日志不记录明文 token、原始设备标识或完整设备哈希。

线上验证发现 EdgeOne Blob SDK 的 `onlyIfNew` 在当前项目中未稳定拒绝第二次覆盖，因此上述方案依赖强一致回读和竞争稳定窗口收敛，已通过实际双设备并发验收，但不宣称数据库事务级原子性。若后续要求在任意网络暂停和跨区域调度下严格线性化，必须把 claim 迁移到支持事务或 CAS 的存储。

EdgeOne KV 是最终一致存储，不用于设备 claim、管理员会话或授权状态。Cloudflare D1 和旧 KV 只作为切换期间的只读迁移源，迁移验证后保留一段回滚窗口。

### API 与管理员边界

公共 API 为 `POST /api/v1/activate`、`POST /api/v1/renew` 和 `GET /healthz`。请求体执行严格大小、类型和格式校验，并用 Rate Limiting binding 抑制滥用。

管理页面和管理 API 统一放在 `/admin/*`，根路径 `/` 以相对跳转进入 `/admin/`。管理员账号和使用 PBKDF2-SHA-256 加盐派生的密码哈希保存在 Blob，禁止保存明文密码；登录成功后生成高熵随机会话 token，仅把 token 摘要作为 Blob key，并通过 `HttpOnly`、`Secure`、`SameSite=Strict` Cookie 交付浏览器。会话记录包含 12 小时绝对到期时间，并通过强一致读取和删除实现即时登出。登录和所有管理写操作执行同源校验，固定只接受 `https://licensed.xyyamsz.cn`；不得以 EdgeOne 函数内部运行 URL 判定同源，也不得在 Location 响应头暴露内部域名。登录接口使用独立限流空间。

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
- [管理员密码被猜测或会话被盗用] → 密码使用高迭代 PBKDF2 哈希、登录独立限流、会话仅保存摘要并使用安全 Cookie，登出立即删除 Blob 会话。
- [Blob 条件写未提供数据库事务级保证] → 使用强一致读取、竞争稳定窗口和 nonce 回读降低并发双绑概率，保留并发验收；严格线性化场景需改用支持事务或 CAS 的存储。
- [密钥丢失会导致无法续签或更新] → 私钥仅存 EdgeOne/GitHub Secrets，并在部署前保存离线备份；公钥提交仓库。

## Migration Plan

1. 在 `main` 参数化发布脚本、切换无激活版 tag 触发、更新版本和变更日志，并验证产物行为不变。
2. 从已验证的 `main` 创建 `licensed`，添加 OpenSpec、客户端鉴权、服务端、管理后台和独立发行配置。
3. 创建 EdgeOne 项目与 Blob，配置环境变量和 Custom Domain，并通过标准输入初始化管理员账号。
4. 创建公开 Gitee 激活版发行仓库，配置 GitHub Secrets 和分支保护。
5. 使用测试 token 完成双设备激活、拒绝、重置、续签和离线宽限验收。
6. 推送 `licensed-v1.0.0` 后校验 GitHub/Gitee 产物和 `latest.json`，再对外发放 token。

从 Cloudflare 迁移时，先在 EdgeOne 默认域名完成接口和双设备验收，再将 D1 的许可证、审计与管理员密码哈希幂等写入 Blob，最后切换 `licensed.xyyamsz.cn`。旧 KV 会话不迁移，管理员切换后重新登录。

回滚时保留 Cloudflare D1、EdgeOne Blob 与密钥，先恢复旧域名路由，再回退服务代码；`main` 无激活版不受影响。已签发租约在宽限期内仍可离线验证，因此不得通过删除任一存储代替正常回滚。

## Open Questions

无。首发只初始化一个管理员账号，不包含邮箱登录、找回密码或多因素认证。
