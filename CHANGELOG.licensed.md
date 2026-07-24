# 激活版更新日志

本文件只记录 `licensed` 分支的许可证、管理服务和独立发行变更。来自 `main` 的共享功能更新继续记录在 `CHANGELOG.md`。

## [许可证服务 1.1.0] - 2026-07-24

### 变更

- 将鉴权 API、账号密码管理后台与部署流水线从 Cloudflare Worker 迁移到腾讯 EdgeOne Node.js 云函数。
- 将 D1 许可证、审计、管理员记录和 KV 会话统一迁移到 EdgeOne Blob；旧会话不迁移，切换后需重新登录。
- 保持 `https://licensed.xyyamsz.cn`、API 请求格式、Ed25519 租约和客户端公钥不变，因此不需要重新激活或发布新的客户端安装包。
- 自定义域名、免费 HTTPS 证书与线上数据已切换到 EdgeOne 海外项目，Cloudflare Worker、D1 与 KV 暂时保留用于回滚。

### 安全

- 设备绑定使用 Blob `onlyIfNew` 条件写、750 毫秒竞争稳定窗口和强一致回读，并通过双设备并发验收；同时明确 Blob 不提供数据库事务级原子保证。
- 管理员密码仍只保存 PBKDF2-SHA-256 哈希，token 仍只保存 HMAC 摘要；EdgeOne 环境变量保存 pepper 和租约私钥。
- 新增 EdgeOne 内存存储测试替身，覆盖双设备并发、撤销、重置、签名篡改、会话注销及明文不落库。
- 已在自定义域名完成账号密码登录、首机激活、第二机拒绝、换机重置、旧租约失效、撤销和并发双设备验收。

## [1.0.0] - 2026-07-24

### 新增

- 增加一机一码 token 激活、30 天设备租约和 7 天离线宽限。
- 增加 Cloudflare Worker、D1 许可证服务及 D1 账号密码、KV 会话保护的管理后台。
- 增加“摄影修图师助手”独立应用身份、更新签名、Gitee 更新源和三平台发行通道。

### 安全

- 将所有文件扫描、匹配、导出、水印和打开文件命令统一置于 Rust 许可证门禁之后。
- 设备标识仅以产品域隔离后的 SHA-256 哈希上传；激活 token 不写入本地凭据或服务端数据库。
- Tauri updater、许可证租约和无激活版 updater 使用互不复用的签名密钥。

### 修复

- 补齐 Worker 独立 CI 所需的 Node.js 类型依赖，确保 GitHub Actions 的 TypeScript 检查与本地结果一致。
- 固定跨平台可选 WASM 运行时依赖，使 macOS 生成的 lockfile 能被 Linux GitHub runner 严格执行 `npm ci`。
- 将签名篡改测试改为稳定翻转首字节，避免 Base64 尾部填充位造成偶发的等价解码。
- 将管理员密码 PBKDF2 迭代次数调整为 Cloudflare Web Crypto 支持上限 100,000 次，并保持随机盐与恒定时间比较。

### 发布验证

- 已发布 `licensed-v1.0.0` 的 macOS Apple Silicon、macOS Intel 和 Windows x64 产物，并同步至独立 Gitee Release 与 `release/latest.json`。
- 已完成两台逻辑设备的激活、第二台拒绝、后台重置、换机激活和旧租约失效协议验收；两台真实设备安装验收仍需上线前人工执行。
