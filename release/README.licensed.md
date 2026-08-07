# 激活版独立发行说明

激活版只从 `licensed` 分支发布，应用身份与无激活版完全分离：

- 产品名：`摄影修图师助手`
- Bundle identifier：`com.masongzhi.rawjpegmatcher.licensed`
- 标签：`licensed-vX.Y.Z`
- 产物前缀：`raw-jpeg-matcher-licensed_`
- Gitee：`masongzhi1/raw-jpeg-matcher-licensed-release`
- 唯一更新清单：`https://gitee.com/masongzhi1/raw-jpeg-matcher-licensed-release/raw/main/release/latest.json`

## 签名材料

本机私钥位于仓库外：

```text
~/.tauri/raw-jpeg-matcher-licensed/updater.key
~/.tauri/raw-jpeg-matcher-licensed/license-ed25519-private.pem
```

GitHub Actions 使用 `TAURI_LICENSED_SIGNING_PRIVATE_KEY` 和
`TAURI_LICENSED_SIGNING_PRIVATE_KEY_PASSWORD`，不得复用无激活版 updater key。

## 授权平台

授权平台代码与 EdgeOne 部署已迁移至 `software-license-platform` 独立维护。本仓库只构建客户端，不管理平台的密钥、部署或线上验收。

## 发布

1. 运行 `npm run check:licensed`、前端和 Rust 测试。
2. 确认 `src-tauri/tauri.licensed.conf.json` 的版本。
3. 在 `licensed` 提交上创建同版本 `licensed-vX.Y.Z` 标签并推送。
4. `.github/workflows/build-licensed-installers.yml` 会验证标签和分支可达性，再构建 macOS 双架构与 Windows x64。
5. 工作流发布 GitHub Release 后，将更新包和唯一的 `release/latest.json` 同步到独立 Gitee 仓库；客户端只读取 Gitee 清单，无需向受保护的 `licensed` 分支写入。

Action 不会自行创建标签。标签、分支或配置版本不匹配时会立即失败。
