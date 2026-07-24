## Why

当前公开版没有设备授权边界，无法为单独销售的商业版本限制激活设备，也容易在后续发布时混淆无激活版与激活版的安装包、更新清单和签名。需要建立长期 `licensed` 分支、服务端签名许可证和完全隔离的发行通道，在保留 `main` 无激活版工作流的同时，为“摄影修图师助手”提供一机一码和可管理的售后授权。

## What Changes

- 在长期 `licensed` 分支中新增首次启动激活门、稳定设备指纹、系统凭据库存储和 Rust 命令级许可证门禁。
- 新增部署在 `licensed.xyyamsz.cn` 的 Cloudflare Worker、D1 数据库、签名租约、续签接口与限流。
- 新增使用管理员账号密码登录的管理后台，支持批量生成 token、导出、查询、撤销和人工换机重置。
- 为激活版新增独立产品身份、`1.0.0` 版本流、updater 签名密钥、`licensed-vX.Y.Z` tag、产物命名和 Gitee 更新仓库。
- 将无激活版与激活版发布改为 tag 驱动，并验证 tag、版本与目标长期分支一致。
- **BREAKING**：仅对 `licensed` 分支构建生效；未持有有效许可证时，所有业务 Tauri 命令均被拒绝，且旧应用的本地配置不迁移到新产品身份。

## Capabilities

### New Capabilities

- `licensed-device-activation`: 覆盖设备指纹、首次激活、签名租约、离线宽限、续签、凭据存储和命令级门禁。
- `license-administration`: 覆盖 Cloudflare 授权数据、管理员身份校验、token 批量生成、查询、撤销、重置和审计。
- `licensed-release-distribution`: 覆盖长期分支约束、独立产品身份、tag 校验、三平台产物、独立签名与 Gitee updater 清单。

### Modified Capabilities

无。无激活版现有能力与业务行为保持不变。

## Impact

- 客户端：React 启动壳层、Tauri Rust 命令、平台设备标识、系统凭据库、updater 配置和依赖。
- 服务端：新增 TypeScript Cloudflare Worker、D1 migration、KV 登录会话、Worker Secrets 和 Rate Limiting。
- 发布：调整 GitHub Actions 与发布资源整理脚本，新建公开 Gitee 发行仓库并增加 Cloudflare 部署工作流。
- 运维：新增许可证签名密钥、token 摘要 pepper、激活版 updater 密钥及对应 GitHub/Cloudflare Secrets。
