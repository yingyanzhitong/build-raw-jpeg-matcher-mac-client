# 许可证服务

本目录是“摄影修图师助手”激活版的腾讯云 SCF Web 函数服务。函数部署在广州地域，通过腾讯云永久函数 URL 对外提供 HTTPS；许可证、设备绑定、审计事件、管理员密码哈希和 12 小时登录会话继续存放在现有 EdgeOne Blob 中。

生产入口：

```text
https://1319909213-11o589l07z.ap-guangzhou.tencentscf.com
```

## 安全边界

- `POST /api/v1/activate` 与 `POST /api/v1/renew` 是客户端公开接口。
- `/admin/*` 使用管理员账号密码登录，不依赖邮箱或 Zero Trust。
- 管理员密码使用 PBKDF2-SHA-256、随机盐和 100,000 次迭代后写入 Blob，不保存明文。
- 浏览器只接收 `HttpOnly`、`Secure`、`SameSite=Strict` 会话 Cookie，Blob key 只包含会话 token 的 SHA-256 摘要。
- 激活 token 只以 HMAC 摘要和末四位保存；`TOKEN_PEPPER` 与 `LICENSE_PRIVATE_KEY_PEM` 只配置在 SCF 环境变量中。
- 设备绑定使用 Blob 强一致读取、`onlyIfNew` 条件写、竞争稳定窗口和 nonce 回读。EdgeOne Blob 不提供数据库事务，这套竞争收敛不等同于事务级原子保证。

## 本地验证与打包

```bash
npm ci
npm run typecheck
npm test
npm run build:scf
```

`build:scf` 会生成 `.scf-dist/scf_bootstrap` 和 `.scf-dist/server.mjs`。上传到 SCF 的 ZIP 必须让这两个文件位于压缩包根目录，并保留 `scf_bootstrap` 的可执行权限。

GitHub Actions 会重复执行类型检查、测试和打包，并上传可供 SCF 控制台部署的 ZIP artifact。当前生产函数由腾讯云控制台发布；仓库不保存腾讯云 SecretId/SecretKey，因此流水线不会直接修改 SCF 资源。

## SCF 生产配置

- 地域：广州
- 函数名：`raw-jpeg-matcher-license`
- 函数类型：Web 函数
- 运行环境：Node.js 18.15
- 监听端口：`9000`
- 内存：512 MB
- 执行超时：30 秒
- 公网访问：开启
- 函数 URL：公开访问，CORS 关闭

环境变量：

- `PRODUCT_ID`
- `LICENSE_PUBLIC_KEY_BASE64`
- `TOKEN_PEPPER`
- `LICENSE_PRIVATE_KEY_PEM`
- `EDGEONE_API_TOKEN`
- `EDGEONE_PROJECT_ID`
- `EDGEONE_STORE_NAME`

私钥、pepper 和访问 token 不得提交到仓库。SCF Node.js 18 运行时未默认提供 Web Crypto，适配器会使用 `node:crypto` 的 `webcrypto` 实现签名、HMAC 和摘要计算。

部署后至少验证：

```bash
curl --fail \
  https://1319909213-11o589l07z.ap-guangzhou.tencentscf.com/healthz
```

健康检查必须返回版本 `1.2.0` 和运行时 `tencent-scf`；根路径必须跳转到账号密码管理后台。

## 数据与管理员

现有 Cloudflare D1 数据只在最初切换到 EdgeOne Blob 时迁移一次：

```bash
CLOUDFLARE_API_TOKEN=... \
CLOUDFLARE_ACCOUNT_ID=... \
EDGEONE_PROJECT_ID=... \
EDGEONE_API_TOKEN=... \
npm run data:migrate
```

SCF 迁移不复制数据，直接使用现有 Blob 项目，因此许可证摘要、设备绑定、审计、管理员、会话和限流数据保持不变。

更新管理员密码时，通过标准输入提供密码：

```bash
read -r -s -p "管理员密码: " license_admin_password
printf '%s' "$license_admin_password" | \
  EDGEONE_PROJECT_ID=... EDGEONE_API_TOKEN=... \
  npm run admin:create -- --username admin
unset license_admin_password
```
