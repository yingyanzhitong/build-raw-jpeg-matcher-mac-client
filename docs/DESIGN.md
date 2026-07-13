---
version: alpha
name: Photo Pairing Assistant
description: A quiet, precise macOS utility for matching and separating photo files.
colors:
  primary: "#202124"
  secondary: "#6F7782"
  neutral: "#F5F7FA"
  surface: "#FFFFFF"
  surface-subtle: "#F8FAFC"
  divider: "#E1E7EE"
  accent: "#1A73E8"
  on-accent: "#FFFFFF"
  success: "#2F9E60"
  danger: "#E5484D"
typography:
  title-sm:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, SF Pro Display, Helvetica Neue, sans-serif"
    fontSize: 13px
    fontWeight: 600
    lineHeight: 1.35
  workspace-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, SF Pro Display, Helvetica Neue, sans-serif"
    fontSize: 15px
    fontWeight: 600
    lineHeight: 1.35
  body-md:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, SF Pro Display, Helvetica Neue, sans-serif"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
  label-md:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, SF Pro Display, Helvetica Neue, sans-serif"
    fontSize: 13px
    fontWeight: 500
    lineHeight: 1.35
  data-sm:
    fontFamily: "JetBrains Mono, SF Mono, Menlo, Monaco, monospace"
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.35
rounded:
  xs: 5px
  sm: 7px
  md: 8px
  lg: 12px
spacing:
  micro: 4px
  xs: 8px
  sm: 12px
  md: 16px
  lg: 24px
  workspace-sidebar: 312px
components:
  app-canvas:
    backgroundColor: "{colors.neutral}"
  workspace-surface:
    backgroundColor: "{colors.surface}"
  workspace-panel:
    backgroundColor: "{colors.surface-subtle}"
  workspace-divider:
    backgroundColor: "{colors.divider}"
  app-navigation:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.secondary}"
    height: 40px
    padding: 16px
  workspace-tab:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.secondary}"
    typography: "{typography.label-md}"
    rounded: "{rounded.sm}"
    height: 40px
    padding: 8px
  workspace-tab-active:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary}"
    typography: "{typography.label-md}"
    rounded: "{rounded.sm}"
    height: 40px
    padding: 8px
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.sm}"
    height: 36px
    padding: 12px
  workspace-tab-active-indicator:
    backgroundColor: "{colors.accent}"
    height: 2px
  status-success:
    backgroundColor: "{colors.success}"
  status-danger:
    backgroundColor: "{colors.danger}"
---

## Overview

照片配对助手是摄影工作流中的桌面工具，不是管理后台或网页仪表盘。它应让摄影师在大量文件之间保持清醒的方向感：界面安静、信息精确、重点动作明确，避免卡片、边框和色块彼此争抢注意力。

本文件采用 [Google `DESIGN.md`](https://github.com/google-labs-code/design.md) 的格式，作为本项目的视觉源头。实现以 macOS 系统行为和系统字体为先，不为“看起来更像组件库”而添加额外装饰。

## Colors

- **Primary** 用于标题、选中导航和关键内容；它是近黑墨色，而非纯黑。
- **Secondary** 用于未选中导航、说明和次级信息。未选中不等于禁用，必须保持清晰可读。
- **Neutral** 是工作台底色；**Surface** 是内容面，二者只用于建立内容层次。连续工作流优先用留白和细分隔线分组，避免在侧栏堆叠卡片。
- **Accent** 只服务于单个主操作、键盘焦点和当前 Tab 的 2px 指示线。它不应用作 Tab 的整块填充背景。
- 成功和错误色仅表达任务结果，不能承担导航状态。

## Typography

使用 San Francisco 作为界面文字，使用系统等宽字体呈现文件名、数量和日志。页面最多同时使用常规与半粗两种字重；大标题不是视觉卖点，工作区标题应服务于快速扫描。

## Layout

窗口由三个稳定层级组成：40px 标题栏、40px 应用导航栏、剩余的功能工作区。应用导航与其下方的工作区之间只保留一条分隔线，不堆叠容器、描边和阴影。

桌面宽度不低于 960px 时，功能工作区采用 312px 配置栏加弹性结果区。Tab 从左侧 16px 对齐，不与窗口标题争夺居中位置。Tab 的最小点击高度为 32px，导航栏自身负责垂直留白。

## Elevation & Depth

层次优先通过留白、底色和一条低对比度分隔线建立。导航区是平面工具栏：没有外层胶囊、没有阴影，也不使用“卡片里再放卡片”的做法。阴影只保留给模态框和浮动日志等确实脱离文档流的内容。

## Shapes

圆角保持克制：输入与按钮使用 7px，内容卡片使用 8px。顶层导航默认不需要圆角；只有悬停和键盘焦点可以出现轻微的 5px 背景提示。

## Components

### Workspace tabs

工作区 Tab 是应用导航，而不是表单分段控件。`图片 / RAW 匹配` 与 `一键分离` 放在同一条 40px 导航栏中，以图标和文字表达功能。

- Tab 列表没有背景、边框、内边距或阴影。
- 当前 Tab 使用 primary 文字和底部 2px accent 指示线；不使用白色内卡片或投影。
- 未选中 Tab 使用 secondary 文字，保留与正文相近的可读对比度；不得呈现为 disabled。
- 悬停仅使用很浅的 neutral 背景；键盘焦点使用 accent 焦点环。
- 方向切换（`图片 → RAW` / `RAW → 图片`）属于匹配工作区内部控件，视觉权重低于应用导航。

### Buttons and status

每个工作区在同一时刻只突出一个蓝色主按钮。统计、筛选、格式标签和次级操作使用中性色。任务尚未准备好时，使用说明文字解释原因，不以低对比度图标或灰化 Tab 作为唯一提示。

## Do's and Don'ts

- 保持应用导航、工作区导航和任务操作三层的权重递减。
- 用内容对齐和留白表达分组，优先删除不承载状态的边框。
- 保留系统字体、标准键盘焦点和 `⌘1` / `⌘2` 工作区切换。
- 不要在 Tab 外再包一层圆角灰色容器。
- 不要把选中 Tab 做成与内容卡片相同的白色浮层。
- 不要让未选中 Tab 的对比度低到像禁用状态。
- 不要同时在导航、方向切换和主按钮上使用高饱和蓝色填充。
