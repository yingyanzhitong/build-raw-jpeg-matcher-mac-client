## ADDED Requirements

### Requirement: One-way long-lived branch
仓库 MUST 使用 `main` 维护无激活版并使用 `licensed` 维护激活版，共享功能 MUST 只从 `main` 合并到 `licensed`。

#### Scenario: Shared feature reaches the licensed edition
- **WHEN** `main` 完成并验证共享功能
- **THEN** 维护者通过合并提交把该功能带入 `licensed` 并运行激活版不变量检查

#### Scenario: Licensed code targets main
- **WHEN** 变更尝试从 `licensed` 合并回 `main`
- **THEN** 仓库规则和维护流程拒绝该方向

### Requirement: Independent application identity
激活版 MUST 使用名称“摄影修图师助手”、identifier `com.masongzhi.rawjpegmatcher.licensed` 和独立本地数据目录，并 MUST 从版本 `1.0.0` 开始独立演进。

#### Scenario: Both editions are installed
- **WHEN** 用户在同一电脑安装无激活版和激活版
- **THEN** 两个应用可独立启动且不会共享配置、凭据或 updater 状态

### Requirement: Tag and branch validation
无激活版 MUST 由 `vX.Y.Z` tag 触发，激活版 MUST 由 `licensed-vX.Y.Z` tag 触发，工作流 MUST 验证 tag 版本和提交可达分支。

#### Scenario: Valid legacy tag is pushed
- **WHEN** `vX.Y.Z` 指向 `main` 可达提交且等于无激活版配置版本
- **THEN** 工作流构建并发布无激活版

#### Scenario: Licensed tag points to main only
- **WHEN** `licensed-vX.Y.Z` 指向不可从 `licensed` 到达的提交
- **THEN** 工作流在构建前失败

#### Scenario: Tag and config version differ
- **WHEN** tag 中版本与对应 Tauri 配置版本不同
- **THEN** 工作流在创建 Release 前失败

### Requirement: Isolated licensed artifacts
激活版 MUST 为 macOS Apple Silicon、macOS Intel 和 Windows x64 生成 `raw-jpeg-matcher-licensed_*` 安装包与 updater 载荷。

#### Scenario: Licensed release assets are prepared
- **WHEN** 三个平台构建完成
- **THEN** 资源整理脚本只接受三个目标的唯一匹配文件并生成带激活版 tag 的 URL

### Requirement: Independent updater trust
激活版 MUST 使用不同于无激活版和许可证租约的 updater 签名密钥、公钥、endpoint 和清单。

#### Scenario: Licensed client checks for updates
- **WHEN** 激活版调用 Tauri updater
- **THEN** 客户端只读取新 Gitee 仓库 `release/latest.json` 并使用激活版 updater 公钥验证

#### Scenario: Cross-channel artifact is offered
- **WHEN** 激活版清单或客户端下载到无激活版签名产物
- **THEN** Tauri updater 拒绝安装

### Requirement: Dedicated Gitee mirror
激活版 MUST 发布到公开仓库 `masongzhi1/raw-jpeg-matcher-licensed-release`，并 MUST 使用 `licensed-vX.Y.Z` Release 和 `main/release/latest.json`。

#### Scenario: Licensed release succeeds
- **WHEN** GitHub 激活版 Release 的所有附件完成
- **THEN** 工作流同步对应 Gitee Release，并在附件完整后原子更新激活版 `latest.json`

#### Scenario: Legacy updater checks
- **WHEN** 无激活版检查更新
- **THEN** 其 endpoint、Gitee 仓库和清单保持原样

### Requirement: Licensed service deployment
EdgeOne 服务 MUST 只从激活版相关分支的服务目录变更部署，并 MUST 在客户端发布前完成测试、部署和健康检查。

#### Scenario: Service change is pushed to licensed
- **WHEN** `licensed` 的服务目录或 migration 发生变化
- **THEN** GitHub Actions 验证测试后部署到 `licensed.xyyamsz.cn`

#### Scenario: Service change appears on main
- **WHEN** `main` 不包含激活服务目录
- **THEN** 无激活版工作流不执行任何 EdgeOne 部署
