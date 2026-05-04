# 项目问题记录与解决方案

## 1. UI 极简黑白艺术风重构

**问题**：界面使用蓝色按钮、蓝色高亮等彩色元素，不符合"极简黑白艺术风"的设计要求。

**解决**：将所有颜色类名替换为 zinc 色系：
- 按钮：`bg-blue-500` → `bg-zinc-800 text-white`，形状改为 `rounded-full`
- 高亮：`bg-blue-50` → `bg-zinc-50 ring-zinc-200`
- 聊天气泡：用户蓝色气泡 → `bg-zinc-100 text-zinc-700`，AI 白色气泡带 `border-zinc-100`
- 图标背景统一 `bg-zinc-50 text-zinc-500`
- 引入衬线字体 `Noto Serif SC` 用于标题

---

## 2. 残留颜色类名

**问题**：全局替换后仍有零散未清理的彩色类名，如 `blue-500` spinner、`text-gray-*` 等。

**解决**：用 `grep` 搜索所有颜色类名，逐一替换：
- `border-blue-*` / `bg-blue-*` / `text-blue-*` → 对应 zinc 色系
- `text-gray-*` → `text-zinc-*`
- spinner 边框 `border-blue-500` → `border-zinc-300 border-t-transparent`

---

## 3. 收藏夹系统修复

**问题**：收藏功能存在三个问题：
1. 收藏按钮不显示（被条件渲染隐藏）
2. 收藏 ID 用 `fav-${i}`（基于数组索引），消息变化后索引错位
3. 刷新页面后收藏丢失（未持久化）

**解决**：
- 收藏按钮改为始终可见，根据内容是否已收藏显示实心/空心状态
- ID 方案改为 `fav-${Date.now()}` 并增加内容去重（匹配 question + answer 字段）
- 接入 `localStorage`，`useEffect` 监听变化自动保存

---

## 4. 聊天模式验证逻辑错误

**问题**："整本书"模式错误地要求必须在右侧勾选书籍才能发送消息，导致用户未勾选时信息发不出去。

**解决**：将条件判断从 `chatMode !== 'chapter'` 改为 `chatMode === 'cross'`。共修复 4 处（输入框 placeholder、发送按钮 disabled、handleSend 校验、底部提示文字），只有综合阅读模式才需要勾选书籍。

---

## 5. 前端文件拆分后白屏

**问题**：将单文件 `index.html` 拆分为 `LeftPanel.jsx`、`MiddlePanel.jsx`、`RightPanel.jsx`、`app.jsx` 四个文件后，页面白屏。原因是浏览器请求 `.jsx` 文件时，FastAPI 后端没有相应的静态文件路由。

**解决**：在 `main.py` 中挂载静态文件路由：
```python
app.mount("/components", StaticFiles(directory=...), name="components")
@app.get("/app.jsx")
async def serve_app_jsx():
    return FileResponse(...)
```

---

## 6. 批量上传串行处理

**问题**：前端 `handleUploadMultiple` 用 for 循环逐个上传文件，大 PDF 需等前一本完全处理完（切章节 + 向量化）才开始下一本，上传多本书时排队时间过长。

**解决**：
- 后端新增 `POST /books/batch-upload` 端点，使用 `asyncio.gather` 并行处理所有书籍
- 支持部分失败，返回 `{ results: [...], errors: [...] }`
- 前端优先调用批量端点，不可用时自动降级为逐个上传
- 上传进度显示改为 `上传中 (2/5)` 格式

---

## 7. 后端重启丢书籍列表

**问题**：`analysis_results` 存在进程内存字典中，后端重启后书籍列表全部丢失。虽然 ChromaDB 中的章节数据还在，但左侧列表空了，用户需重新上传。

**解决**：增加磁盘持久化：
- 上传/批量上传成功后 → 写入 `data/books_index.json`（仅存元信息，不存章节正文）
- 删除书籍时 → 同步更新索引文件
- 后端启动时 → 自动读取索引文件恢复 `analysis_results`
- 前端页面加载时 → 调用 `GET /books/list` 恢复书籍列表，自动选中第一本

---

## 8. 章节导航位置不合理

**问题**：章节列表以 dropdown 形式放在中间区域顶部，点击书名后才显示，操作路径割裂。

**解决**：改为点击左侧书名后直接在该书下方展开章节列表：
- 左侧栏分为"文件视图"和"章节视图"两种状态
- 文件视图显示所有书籍，点击书名切换到章节视图
- 章节视图显示当前书籍信息和所有章节，点击返回回到文件视图
- 选中章节用圆点 `●` 高亮

---

## 9. 只能问当前章节

**问题**：对话上下文仅限当前章节内容，无法针对整本书或多本书提问。

**解决**：增加三种独立对话模式：
- **当前章节** — 上下文 = 当前章节内容
- **整本书** — 上下文 = RAG 搜索全书章节（ChromaDB 语义检索 top-3）
- **综合阅读** — 跨本书 RAG 对比

后端通过 SSE 流式返回回答，末尾附带来源章节信息，前端渲染为可点击的来源 badge。

---

## 讨论过但未修改的问题

### LangChain 依赖过重
- 项目仅用 LangChain 调 DeepSeek API（`ChatOpenAI` + message schema）
- 可替换为 `httpx` 直调，省掉 `langchain` 和 `langchain-openai` 两个依赖
- **决定保留**：因 LangChain 是简历关键词，且当前用法未被其抽象绑架

### `backend/app/routers/books.py` 死代码
- 该路由从未在 `main.py` 中注册，所有端点无效
- 功能已被 `book_processor.py` 中的 `/upload-and-analyze` 等端点替代
- **可删除**，无影响

### 无数据库
- 书籍信息靠进程内存 + ChromaDB + JSON 文件管理
- 规模扩大后需引入 SQLite 或 PostgreSQL
