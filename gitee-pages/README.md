# Gitee Pages 页面

此目录是 RAW/JPEG Matcher 的静态下载页源码。GitHub Actions 会把目录内容同步到 Gitee 仓库的 `pages` 分支根目录。

页面下载按钮读取 `latest-cache.json`。该文件由同步脚本从发布流程生成的 `release/latest.json` 复制而来，字段优先级为：

1. `platforms.*.installer_url`
2. `installers.*.url`

## Gitee 配置

在 Gitee Pages 中将发布源配置为：

- 分支：`pages`
- 目录：仓库根目录

如果未开通 Gitee Pages Pro，Gitee 可能不会在推送后自动重新构建 Pages，需要在 Gitee 页面设置中手动点击更新。
