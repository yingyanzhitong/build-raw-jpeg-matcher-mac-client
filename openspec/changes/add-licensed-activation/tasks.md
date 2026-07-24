## 1. 无激活版发行基础

- [x] 1.1 参数化发布资源脚本，使版本、tag、仓库和资产前缀可由工作流显式传入
- [x] 1.2 将无激活版工作流改为 `vX.Y.Z` tag 触发，并在构建前校验版本与 `main` 可达性
- [x] 1.3 更新无激活版版本、中文 CHANGELOG 和发行说明，并通过现有前端、Rust 与脚本测试

## 2. licensed 分支与产品身份

- [ ] 2.1 从已验证的 `main` 创建长期 `licensed` 分支并添加单向合并说明
- [ ] 2.2 新增 `tauri.licensed.conf.json`，配置 `1.0.0`、摄影修图师助手、独立 identifier、updater endpoint 和公钥
- [ ] 2.3 增加激活版分支不变量检查，验证鉴权模块、产品身份、服务地址和 Gitee 更新源

## 3. Cloudflare 许可证服务

- [ ] 3.1 创建 Worker TypeScript 工程、Wrangler 配置、D1 migration、Secrets 声明和本地测试环境
- [ ] 3.2 实现 token 规范化、HMAC 摘要、Crockford Base32 批量生成和 Ed25519 租约签名
- [ ] 3.3 实现 `/api/v1/activate` 的严格校验、原子单设备绑定、幂等响应、限流和稳定错误码
- [ ] 3.4 实现 `/api/v1/renew` 的签名校验、设备/代次/状态校验、30 天租约和 7 天宽限
- [ ] 3.5 实现不泄露敏感值的结构化日志、`license_events` 审计和 `/healthz`

## 4. Cloudflare Access 管理后台

- [ ] 4.1 实现 Access JWT 的 JWKS、issuer、audience 和管理员邮箱验证
- [ ] 4.2 实现批量生成、分页筛选、详情事件、撤销和人工重置管理 API
- [ ] 4.3 实现同源 `/admin/` 页面，支持一次性复制、CSV 导出、查询、撤销和重置确认
- [ ] 4.4 增加管理 API 未认证、伪造 JWT、明文不落库和管理操作审计测试

## 5. Rust 许可证核心与命令门禁

- [ ] 5.1 添加许可证网络、签名、哈希、时间和系统凭据库依赖与模块结构
- [ ] 5.2 实现 macOS `IOPlatformUUID`、Windows `MachineGuid` 读取和产品域设备哈希
- [ ] 5.3 实现签名租约解析、设备/产品/代次校验、30 天有效期、7 天宽限和时间回拨检测
- [ ] 5.4 实现 Keychain/Credential Manager 存储、状态查询、激活与 24 小时节流续签命令
- [ ] 5.5 为所有业务 Tauri 命令增加统一 Rust 门禁并确保拒绝发生在副作用之前
- [ ] 5.6 增加设备、签名篡改、错误设备、过期/宽限、凭据失败和未授权命令单元测试

## 6. 激活版用户界面

- [ ] 6.1 实现启动许可证状态机，未通过时不挂载业务工作区
- [ ] 6.2 实现摄影工作台风格激活门、token 输入、设备码复制、错误恢复和成功过渡
- [ ] 6.3 在激活门保留独立 updater 检查与安装，并在工作区展示激活/离线宽限状态
- [ ] 6.4 增加激活状态映射、错误文案、离线宽限和业务工作区挂载测试

## 7. 独立发行与部署工作流

- [ ] 7.1 新增 `licensed-vX.Y.Z` tag 工作流，校验 `licensed` 可达性和独立版本
- [ ] 7.2 使用独立 updater Secret 构建 macOS 双架构和 Windows x64，并生成 `raw-jpeg-matcher-licensed_*` 资产
- [ ] 7.3 新建并同步 `masongzhi1/raw-jpeg-matcher-licensed-release` 的 Release 和 `release/latest.json`
- [ ] 7.4 新增 `licensed` 服务目录变更触发的 Worker 测试、D1 migration、部署和健康检查工作流
- [ ] 7.5 配置 GitHub Secrets、分支保护和禁止 `licensed → main` 的仓库规则

## 8. 验证、部署与发布

- [ ] 8.1 运行前端、Rust、Worker、OpenSpec 和发行脚本全量自动测试
- [ ] 8.2 验证两个应用可并存、tag/分支错误会失败、两套清单/签名/产物不会串线
- [ ] 8.3 创建 Cloudflare D1、Secrets、Custom Domain 和 Access 策略并部署服务
- [ ] 8.4 用测试 token 完成首机激活、第二机拒绝、后台重置、第二机激活和旧租约失效验收
- [ ] 8.5 提交并推送两条分支，创建并推送对应 tag，确认 GitHub/Gitee Release 和 updater 清单
