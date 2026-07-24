# `licensed` 长期分支维护约定

`main` 是公开无激活版，`licensed` 是包含许可证客户端、EdgeOne 鉴权服务和独立发行配置的长期分支。

鉴权服务运行在 EdgeOne 海外项目的 Node.js 云函数中，许可证、管理员、会话和审计数据存放于 EdgeOne Blob。Cloudflare Worker、D1 与 KV 在迁移后仅保留回滚窗口，不再承载 `licensed.xyyamsz.cn`。

## 合并方向

- 共享功能只允许从 `main` 合并到 `licensed`。
- 禁止把 `licensed` 合并、rebase 或 cherry-pick 回 `main`。
- 合并 `main` 后必须运行 `npm run check:licensed`，确认许可证模块、产品身份、服务地址和独立更新源仍然存在。
- 如果共享改动同时修改了 `src-tauri/src/lib.rs`、`src/App.tsx`、Tauri 配置或发布工作流，应以 `licensed` 的鉴权边界和发行身份为准解决冲突。

推荐流程：

```bash
git switch licensed
git fetch origin
git merge --no-ff origin/main
npm run check:licensed
npm run test:state
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

## 发行标签

- 无激活版：从 `main` 可达的 `vX.Y.Z`。
- 激活版：从 `licensed` 可达的 `licensed-vX.Y.Z`。
- GitHub Actions 只响应已推送的标签，不在工作流中自行创建标签。
- 激活版版本以 `src-tauri/tauri.licensed.conf.json` 为准；首个版本为 `1.0.0`。

## 必须保留的隔离项

- 产品名：`摄影修图师助手`
- Bundle identifier：`com.masongzhi.rawjpegmatcher.licensed`
- 服务地址：`https://licensed.xyyamsz.cn`
- 更新清单：`https://gitee.com/masongzhi1/raw-jpeg-matcher-licensed-release/raw/main/release/latest.json`
- 产物前缀：`raw-jpeg-matcher-licensed_`
- Tauri updater、许可证租约和原无激活版 updater 使用三套不同的签名密钥。
