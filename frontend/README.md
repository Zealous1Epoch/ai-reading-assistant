# 前端开发指南

## 架构

- 单文件架构：所有 HTML / CSS / JSX 集中在 `frontend/index.html`
- React 18 + Babel standalone（无构建步骤，直接在浏览器中编译 JSX）
- Tailwind CSS via CDN
- FastAPI 后端接口基址：`http://localhost:8000`

## UI 风格 — 极简黑白艺术风

- 背景 `bg-zinc-50`，主容器 `bg-white rounded-3xl border border-zinc-200`
- 三个面板之间 `p-3 gap-3`，整体有呼吸感
- 标题用衬线体 `font-serif-heading`（`Noto Serif SC`）
- 按钮统一胶囊形 `rounded-full`

### 色彩禁用
- **不允许出现彩色**（蓝色、紫色、橙色、红色等一律去掉）
- 图标背景统一 `bg-zinc-50 text-zinc-500`
- 选中高亮用 `bg-zinc-50 ring-zinc-200`
- 按钮用 `bg-zinc-800 text-white`
- 聊天气泡：用户 `bg-zinc-100 text-zinc-700`，AI `bg-white text-zinc-700 border border-zinc-100`
- 引用 badge：`bg-zinc-50 text-zinc-600 border border-zinc-200`
- 标签 / 来源标注：`bg-white text-zinc-500 border-zinc-200 rounded-full`

### 间距与呼吸感
- 主容器 `p-3 gap-3`
- 卡片内标题头 `px-4 pt-4 pb-2`
- 卡片内正文区 `px-4 pt-3 pb-4`
- 行间距 `leading-relaxed`，段间距 `mt-1.5`

## 工具结果渲染

- 每个问题 / 标题独占一个卡片，`text-base font-bold text-zinc-900`
- 正文 `text-sm text-zinc-700`，首行缩进 `text-indent: 2em`
- 卡片内部用分隔线 `border-b border-zinc-50` 区分标题头和正文区
- 无序列表：
  - 顶层用 `·`（U+00B7 黑点），`pl-5`
  - 缩进子项用 `◦`（U+25E6 空心点），`pl-7`
- 有序列表保持编号，`pl-5`
- 禁止 `*` 和 `#` 符号显示（`**bold**` 转 `<strong>` 后清除残余）
- markdown 表格自动转成要点列表
- 思维导图走 markmap 库渲染

## 组件结构

- `LeftPanel` — 左侧栏：来源列表、书籍章节导航
- `MiddlePanel` — 中间栏：章节内容、对话消息、输入框
- `RightPanel` — 右侧栏：AI 工具卡片、工具结果、收藏夹
- `App` — 主应用：状态管理、API 调用

## 工具栏行为

- 所有工具（总结、背景调研、读书十问、思维导图、书籍推荐、芒格辩论）作用于**左侧当前展开的那本书**，与综合阅读模式的勾选无关
- 需要输入的工具（总结、芒格辩论）先显示输入框，提交后调 API
- 结果到达后自动切换到结果视图，显示返回按钮

## 对话模式

- 三种独立对话历史：
  - `chapter` — 当前章节
  - `book` — 整本书（RAG 搜索）
  - `cross` — 综合阅读（多本书 RAG 对比）
- 来源标注显示在回答底部，点击可跳转到原文
- 引用格式 `《书名》·章节名` 渲染为小 badge
- 回答中禁止使用 Markdown 格式符号，引用必须标注来源
