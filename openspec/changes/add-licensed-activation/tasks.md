## 1. 无激活版发行基础

- [x] 1.1 参数化发布资源脚本，使版本、tag、仓库和资产前缀可由工作流显式传入
- [x] 1.2 将无激活版工作流改为 `vX.Y.Z` tag 触发，并在构建前校验版本与 `main` 可达性
- [x] 1.3 更新无激活版版本、中文 CHANGELOG 和发行说明，并通过现有前端、Rust 与脚本测试

## 2. licensed 分支与产品身份

- [x] 2.1 从已验证的 `main` 创建长期 `licensed` 分支并添加单向合并说明
- [x] 2.2 新增 `tauri.licensed.conf.json`，配置 `1.0.0`、摄影修图师助手、独立 identifier、updater endpoint 和公钥
- [x] 2.3 增加激活版分支不变量检查，验证鉴权模块、产品身份、服务地址和 Gitee 更新源

## 3. Cloudflare 许可证服务

- [x] 3.1 创建 Worker TypeScript 工程、Wrangler 配置、D1 migration、Secrets 声明和本地测试环境
- [x] 3.2 实现 token 规范化、HMAC 摘要、Crockford Base32 批量生成和 Ed25519 租约签名
- [x] 3.3 实现 `/api/v1/activate` 的严格校验、原子单设备绑定、幂等响应、限流和稳定错误码
- [x] 3.4 实现 `/api/v1/renew` 的签名校验、设备/代次/状态校验、30 天租约和 7 天宽限
- [x] 3.5 实现不泄露敏感值的结构化日志、`license_events` 审计和 `/healthz`

## 4. 账号密码管理后台

- [x] 4.1 实现 D1 管理员密码哈希、KV 会话、安全 Cookie、同源校验和登录限流
- [x] 4.2 实现批量生成、分页筛选、详情事件、撤销和人工重置管理 API
- [x] 4.3 实现同源 `/admin/` 页面，支持一次性复制、CSV 导出、查询、撤销和重置确认
- [x] 4.4 增加管理 API 未认证、错误密码、伪造会话、登出、明文不落库和管理操作审计测试

## 5. Rust 许可证核心与命令门禁

- [x] 5.1 添加许可证网络、签名、哈希、时间和系统凭据库依赖与模块结构
- [x] 5.2 实现 macOS `IOPlatformUUID`、Windows `MachineGuid` 读取和产品域设备哈希
- [x] 5.3 实现签名租约解析、设备/产品/代次校验、30 天有效期、7 天宽限和时间回拨检测
- [x] 5.4 实现 Keychain/Credential Manager 存储、状态查询、激活与 24 小时节流续签命令
- [x] 5.5 为所有业务 Tauri 命令增加统一 Rust 门禁并确保拒绝发生在副作用之前
- [x] 5.6 增加设备、签名篡改、错误设备、过期/宽限、凭据失败和未授权命令单元测试

## 6. 激活版用户界面

- [x] 6.1 实现启动许可证状态机，未通过时不挂载业务工作区
- [x] 6.2 实现摄影工作台风格激活门、token 输入、设备码复制、错误恢复和成功过渡
- [x] 6.3 在激活门保留独立 updater 检查与安装，并在工作区展示激活/离线宽限状态
- [x] 6.4 增加激活状态映射、错误文案、离线宽限和业务工作区挂载测试

## 7. 独立发行与部署工作流

- [x] 7.1 新增 `licensed-vX.Y.Z` tag 工作流，校验 `licensed` 可达性和独立版本
- [x] 7.2 使用独立 updater Secret 构建 macOS 双架构和 Windows x64，并生成 `raw-jpeg-matcher-licensed_*` 资产
- [x] 7.3 新建并同步 `masongzhi1/raw-jpeg-matcher-licensed-release` 的 Release 和 `release/latest.json`
- [x] 7.4 新增 `licensed` 服务目录变更触发的 Worker 测试、D1 migration、部署和健康检查工作流
- [x] 7.5 配置 GitHub Secrets、分支保护和禁止 `licensed → main` 的仓库规则

## 8. 验证、部署与发布

- [x] 8.1 运行前端、Rust、Worker、OpenSpec 和发行脚本全量自动测试
- [ ] 8.2 验证两个应用可并存、tag/分支错误会失败、两套清单/签名/产物不会串线
- [x] 8.3 创建 Cloudflare D1、KV、Secrets 和 Custom Domain，初始化管理员账号并部署服务
- [x] 8.4 用测试 token 完成首机激活、第二机拒绝、后台重置、第二机激活和旧租约失效验收
- [x] 8.5 提交并推送两条分支，创建并推送对应 tag，确认 GitHub/Gitee Release 和 updater 清单

## 9. EdgeOne 服务迁移

- [x] 9.1 从 `licensed` 创建独立迁移分支，确认 EdgeOne Node.js 云函数、Blob 强一致读取和 `onlyIfNew` 条件写能力，并记录 Blob 不具备事务级原子保证的限制
- [x] 9.2 将激活、续签、账号密码后台、会话、审计和限流从 Cloudflare D1/KV 迁移到 EdgeOne Blob，并增加内存存储测试
- [x] 9.3 增加 D1 到 Blob 的幂等数据迁移脚本、EdgeOne 管理员初始化脚本和 EdgeOne GitHub Actions
- [x] 9.4 创建 EdgeOne 海外项目、配置环境变量、迁移线上数据并在默认域名完成双设备协议验收
- [x] 9.5 将 `licensed.xyyamsz.cn` 切换到 EdgeOne，验证管理后台和客户端接口后保留 Cloudflare 回滚窗口
- [x] 9.6 更新版本与中文变更日志，提交、推送迁移分支并创建服务标签

## 10. 自定义域名管理入口

- [x] 10.1 将根路径接入 EdgeOne 云函数并相对跳转到 `/admin/`，修复未登录跳转泄露内部运行域名的问题
- [x] 10.2 补充根路径、公开 Origin 登录和内部域名不泄露的自动测试，并完成自定义域名线上验证
