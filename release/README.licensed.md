# 激活版独立发行说明

激活版只从 `licensed` 分支发布，应用身份与无激活版完全分离：

- 产品名：`摄影修图师助手`
- Bundle identifier：`com.masongzhi.rawjpegmatcher.licensed`
- 标签：`licensed-vX.Y.Z`
- 产物前缀：`raw-jpeg-matcher-licensed_`
- Gitee：`masongzhi1/raw-jpeg-matcher-licensed-release`
- 主更新清单：`https://github.com/yingyanzhitong/build-raw-jpeg-matcher-mac-client/releases/latest/download/latest.json`
- 备用更新清单：`https://gitee.com/masongzhi1/raw-jpeg-matcher-licensed-release/raw/main/release/latest.json`

## 签名材料

本机私钥位于仓库外：

```text
~/.tauri/raw-jpeg-matcher-licensed/updater.key
~/.tauri/raw-jpeg-matcher-licensed/license-ed25519-private.pem
```

GitHub Actions 使用 `TAURI_LICENSED_SIGNING_PRIVATE_KEY` 和
`TAURI_LICENSED_SIGNING_PRIVATE_KEY_PASSWORD`，不得复用无激活版 updater key。
Cloudflare Worker 使用独立的 `LICENSE_PRIVATE_KEY_PEM` Secret；token HMAC 使用
`TOKEN_PEPPER` Secret。

## 发布

1. 先确认 `licensed` 分支的 Cloudflare 部署工作流成功。
2. 运行 `npm run check:licensed`、前端/Rust/Worker 全量测试。
3. 确认 `src-tauri/tauri.licensed.conf.json` 的版本。
4. 在 `licensed` 提交上创建同版本 `licensed-vX.Y.Z` 标签并推送。
5. `.github/workflows/build-licensed-installers.yml` 会验证标签、分支可达性、在线服务和激活接口，再构建 macOS 双架构与 Windows x64。
6. 工作流将 GitHub 主更新清单作为 Release 的 `latest.json` 资源发布，再把更新包和 `release/latest.json` 同步到独立 Gitee 仓库；无需向受保护的 `licensed` 分支写入，Gitee 的 DMG 上传也不会阻塞自动更新清单。

Action 不会自行创建标签。标签、分支或配置版本不匹配时会立即失败。
