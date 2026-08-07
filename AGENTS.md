# 仓库协作说明

## 提交与发布规则

- 用户只说“提交”时，创建本地 Git commit 后推送当前分支到远程；不得创建或推送 tag、不得手动触发 GitHub Actions，也不得同步任何 Release。
- 只有用户明确使用“发布”一词时，才可执行发布流程：完成必要校验后，创建并推送正确的 tag，并按对应工作流触发 GitHub Actions 与发行同步。
- 用户只说“推送”而未明确“发布”时，仅推送已有分支提交；不得自行创建或推送 tag，也不得手动启动工作流。
- 部署与发行工作流必须仅由对应的发布 tag 触发，保证普通分支提交的推送不会启动发布或部署。
- 发布 tag 推送成功后，立即向企业微信机器人 `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=53a405fd-f482-41d7-a68f-a812c6ea611e` 推送“发布已触发”的 Markdown 消息，正文必须使用以下格式：

  ```markdown
  # 🚀 发布已触发
  > 版本：<font color="warning">{版本}</font>
  > 标签：<font color="warning">{tag}</font>
  > 工作流：[Build Licensed Installers]({工作流链接})
  ```

  不得在该消息中发送构建完成状态、Release/Gitee 同步状态或附件统计。
- 企业微信通知发送成功后立即向用户返回；不得等待 GitHub Actions、Gitee 同步或安装包构建完成，也不得将其结果作为本轮发布完成的前提。
