# 激活版更新日志

本文件只记录 `licensed` 分支的许可证、管理服务和独立发行变更。来自 `main` 的共享功能更新继续记录在 `CHANGELOG.md`。

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
