# 许可证服务

本目录是“摄影修图师助手”激活版的 EdgeOne Node.js 云函数服务。EdgeOne Blob 使用强一致读取保存许可证、设备绑定、审计事件、管理员密码哈希和 12 小时登录会话。

## 安全边界

- `POST /api/v1/activate` 与 `POST /api/v1/renew` 是客户端公开接口。
- `/admin/*` 使用管理员账号密码登录，不依赖邮箱或 Zero Trust。
- 管理后台可创建、查看和撤销 API Key；Key 只在创建响应中返回一次，Blob 仅保存带域隔离的 HMAC 摘要、前缀与末四位。
- `POST /api/v1/tokens` 仅接受有效 API Key，可供商城或自动发货系统下发销售 token；每把 Key 默认限制为每分钟 30 次请求，撤销后立即失效。
- 管理员密码使用 PBKDF2-SHA-256、随机盐和 100,000 次迭代后写入 Blob，不保存明文。
- 浏览器只接收 `HttpOnly`、`Secure`、`SameSite=Strict` 会话 Cookie，Blob key 只包含会话 token 的 SHA-256 摘要。
- token 仅以 HMAC 摘要和末四位保存；`TOKEN_PEPPER` 与 `LICENSE_PRIVATE_KEY_PEM` 必须使用 EdgeOne 环境变量，不得写入配置或仓库。
- 设备绑定先执行强一致读取，再通过 Blob `onlyIfNew` 写入，并在 750 毫秒竞争稳定窗口后强一致回读获胜 nonce；已覆盖双设备并发测试。
- EdgeOne Blob 当前不提供数据库事务，且线上验证发现 SDK 的 `onlyIfNew` 未稳定拒绝覆盖，因此这套竞争收敛不是数据库级原子保证。若业务要求在任意网络延迟下严格线性化的一机一码，仍需接入支持事务或 CAS 的存储。

## 通过接口下发 token

登录 [授权控制台](https://licensed.xyyamsz.cn/admin/) 后，点击「API Key」创建一把仅供服务端保存的 Key。明文 Key 关闭提示框后无法再次查看；泄露或不再使用时请立即在后台撤销并新建。

使用 Key 调用 `POST https://licensed.xyyamsz.cn/api/v1/tokens`：

```bash
curl --request POST 'https://licensed.xyyamsz.cn/api/v1/tokens' \
  --header "Authorization: Bearer $LICENSE_ISSUANCE_API_KEY" \
  --header 'Content-Type: application/json' \
  --data '{"count":1,"note":"订单 #1001"}'
```

- `count` 可选，范围为 1–100，省略时为 1。
- `note` 可选，最多 120 个字符，会显示在授权管理后台。
- 成功时返回 `201` 与本次创建的 `tokens`；其中的明文 token 不会保存到服务端，调用方应立即交付或安全保存。
- Key 缺失、格式错误、未知或已撤销时返回 `401 INVALID_API_KEY`；过于频繁时返回 `429 RATE_LIMITED`。

## 验证与部署

```bash
npm ci
npm run typecheck
npm test
EDGEONE_API_TOKEN=... npm run deploy
```

部署脚本只打包 `cloud-functions`、`src` 和生产依赖，并固定部署到不要求 ICP 备案的海外区域；不会上传本地 `node_modules`、测试或运维文件。

首次创建项目后，通过 `edgeone makers link` 和 `edgeone makers env set` 配置以下环境变量：

- `PRODUCT_ID`
- `LICENSE_PUBLIC_KEY_BASE64`
- `TOKEN_PEPPER`
- `LICENSE_PRIVATE_KEY_PEM`

现有 Cloudflare D1 数据只在首次切换时迁移一次：

```bash
CLOUDFLARE_API_TOKEN=... \
CLOUDFLARE_ACCOUNT_ID=... \
EDGEONE_PROJECT_ID=... \
EDGEONE_API_TOKEN=... \
npm run data:migrate
```

迁移脚本只读取 D1 的许可证摘要、设备绑定、审计和管理员密码哈希，不读取 KV 旧会话，切换后管理员需要重新登录。

日后更新管理员密码时，通过标准输入提供密码：

```bash
read -r -s -p "管理员密码: " license_admin_password
printf '%s' "$license_admin_password" | \
  EDGEONE_PROJECT_ID=... EDGEONE_API_TOKEN=... \
  npm run admin:create -- --username admin
unset license_admin_password
```
