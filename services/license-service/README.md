# 许可证服务

本目录是“摄影修图师助手”激活版的 Cloudflare Worker。D1 保存许可证、审计事件和管理员账号密码哈希；KV 保存 12 小时管理员登录会话。

## 安全边界

- `POST /api/v1/activate` 与 `POST /api/v1/renew` 是客户端公开接口，使用独立 Rate Limiting binding。
- `/admin/*` 使用管理员账号密码登录，不依赖邮箱或 Cloudflare Zero Trust。
- 管理员密码使用 PBKDF2-SHA-256、随机盐和 Cloudflare Web Crypto 支持上限 100,000 次迭代后写入 D1，不保存明文。
- 浏览器只接收 `HttpOnly`、`Secure`、`SameSite=Strict` 会话 Cookie，KV key 只包含会话 token 的 SHA-256 摘要。
- `TOKEN_PEPPER` 与 `LICENSE_PRIVATE_KEY_PEM` 必须使用 Worker Secrets，不得写入配置或仓库。

## 验证与部署

```bash
npm ci
npm run typecheck
npm test
npx wrangler deploy --dry-run
npx wrangler d1 migrations apply LICENSE_DB --remote
npx wrangler deploy
```

首次部署后，通过标准输入初始化管理员，避免密码出现在命令参数和 shell 历史中：

```bash
read -r -s -p "管理员密码: " license_admin_password
printf '%s' "$license_admin_password" | npm run admin:create -- --username admin
unset license_admin_password
```

该命令从标准输入读取密码。日后用相同命令和账号可以更新密码，现有 KV 会话会按最长 12 小时自动到期。
