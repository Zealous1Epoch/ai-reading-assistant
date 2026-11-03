# 智能读书助手 - 对话与UI优化设计

日期: 2026-05-12

## 一、按书籍隔离对话

### 现状
`chapterMessages`、`bookMessages`、`crossBookMessages` 三个扁平数组，所有书共用。

### 改动
- 删除 `chapterMessages` 状态
- `bookMessages` 从数组改为 Map：`{ [bookId]: messages[] }`
- `crossBookMessages` 保持独立（不属于任何单本书）
- 切换 `currentBook` 时自动切换对话历史
- 初始化时加载第一本书的对话为空数组
- 删除书籍时同步清理 `bookChats[bookId]`

### 数据流
```
App.jsx:
  bookChats: { [bookId]: { role, content }[] }
  crossBookMessages: { role, content }[]

getActiveMessages():
  若 chatMode === 'cross' → crossBookMessages
  否则 → bookChats[currentBook.book_id] || []

handleSendMessage():
  若 chatMode === 'cross' → 写入 crossBookMessages
  否则 → 写入 bookChats[currentBook.book_id]

handleSelectBook():
  切换 currentBook + currentChapter，不重置对话
```

## 二、对话模式简化

### 现状
三段式切换：当前章 / 整本书 / 综合阅读

### 改动
- 删除 `chapter` 模式
- 保留 `book`（当前书籍）和 `cross`（对比阅读）
- `book` 模式：后端 RAG 搜索当前书所有章节，同时传入 `currentChapter.chapter_id` 作为优先上下文
- API 请求体中始终携带 `book_id`，可选携带 `chapter_id` 用于精准定位
- AI 补充非该章节内容必须在回答中标注「《书名》·章节名」

### MiddlePanel 底部按钮
```
当前：[📖 当前章] [🌐 整本书] [📚 综合阅读]     ← 3个
改为：[📖 当前书籍] [📚 对比阅读]               ← 2个
```

### 后端无需改动
已有的 `/analysis/chat/stream` 接口已支持 `book_id` + 可选 `chapter_id`。

## 三、工具结果面板统一

### 统一标准（参照背景调研面板）
- 每个题目/小节标题：`text-base font-bold text-zinc-900`
- 标题头区域：`px-4 pt-4 pb-2 border-b border-zinc-50`
- 正文区域：`px-4 pt-3 pb-4`
- 正文段落：`text-sm text-zinc-700 leading-relaxed`，首行 `text-indent: 2em`
- 列表顶层：`· ` 黑点 + `pl-5`
- 列表子项：`◦ ` 空心点 + `pl-7`
- 有序列表：保持编号 + `pl-5`
- 卡片容器：`bg-white border border-zinc-100 rounded-xl shadow-sm`

### 改动范围
仅修改 `RightPanel.jsx` 中工具结果渲染部分（第 205-297 行），不新增文件。

### 各工具适配
| 工具 | 当前问题 | 改为 |
|------|----------|------|
| 总结 | 无标题头 | 自动识别编号行作为标题，加分隔线 |
| 背景调研 | 已符合标准 | 作为参照，不动 |
| 读书十问 | 同上逻辑 | 10个问题每个独立卡片 |
| 思维导图 | 使用 markmap 库 | 不做改动（特殊渲染） |
| 书籍推荐 | 无标题头 | 每本书独立卡片 |
| 芒格辩论 | 无标题头 | 专家视角各有卡片 |

## 四、聊天消息段落化

### 改动
仅在 `MiddlePanel.jsx` 的 AI 回复渲染中增加简化段落处理：

```javascript
function renderMessageContent(text) {
  // 1. 清理 Markdown 符号
  const cleaned = cleanMarkdown(text);
  // 2. 渲染内联引用 badge
  const withCitations = renderWithCitations(cleaned);
  // 3. 按双换行分段，每段独立 <p> + 首行缩进
  const paragraphs = withCitations.split(/\n\n+/);
  return paragraphs.map((para, i) =>
    <p key={i} className="text-sm text-zinc-700 leading-relaxed mt-1.5" 
       style={{ textIndent: '2em' }}>
      {para}
    </p>
  );
}
```

### 不做的事
- 不识别标题行加粗（避免复杂正则）
- 不添加分隔线
- 不解析列表符号（AI 输出格式不可控，做多了反而出错）

## 五、涉及文件

| 文件 | 改动类型 | 说明 |
|------|----------|------|
| `frontend/app.jsx` | 中等 | 状态管理重构（bookChats map） |
| `frontend/components/MiddlePanel.jsx` | 中等 | 去掉 chapter 模式、段落化渲染 |
| `frontend/components/RightPanel.jsx` | 局部 | 统一工具结果 CSS |
| 后端 | 不改 | API 接口不需要改动 |
