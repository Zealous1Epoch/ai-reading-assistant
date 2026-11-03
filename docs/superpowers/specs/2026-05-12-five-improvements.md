# 五合一改进设计文档

日期: 2026-05-12

## 一、OCR 进度实时反馈

### 现状
扫描版 PDF 上传后，OCR 在后台静默运行 2-3 分钟，前端无任何进度提示。

### 方案
1. 后端在 book_processor 中维护 `_ocr_progress: dict[book_id, {current, total}]`
2. 复用已有 `GET /books/status/{book_id}` 端点（若不存在则新增）
3. 前端上传后开始轮询（每 2 秒），在 LeftPanel 显示进度条
4. OCR 完成后自动加载书籍列表

### 改动文件
- `backend/app/services/book_processor.py` — 添加 `_ocr_progress` 字典
- `backend/app/routers/book_processor.py` — 确保 `/status/{book_id}` 返回进度
- `frontend/components/LeftPanel.jsx` — 上传进度条改用轮询

## 二、阅读进度记忆

### 方案
- 切换章节时，将 `{bookId, chapterId}` 写入 localStorage key `reading_progress`
- 页面初始化加载书籍列表后，检查是否有该书的进度，有则自动跳转
- 仅记录章节级进度（不记录页内滚动位置，简化实现）

### 改动文件
- `frontend/app.jsx` — handleSelectChapter 写入进度，useEffect 恢复进度

## 三、全文关键词搜索

### 方案
- 后端新增 `GET /search/fulltext?book_id=X&keyword=Y`
- 从 ChromaDB 获取指定书的所有章节，逐章用 `str.find()` 匹配，返回匹配行 + 上下文
- 前端在 LeftPanel 底部加搜索框，结果下拉展示（章节名 + 匹配片段），点击跳转

### 改动文件
- `backend/app/routers/search.py` — 新增 fulltext 端点
- `frontend/components/LeftPanel.jsx` — 搜索框 + 结果列表

## 四、清理死代码

### 方案
直接删除 `backend/app/routers/books.py`（在 main.py 中未注册，从未生效）

## 五、知识图谱 HTML 导出

### 方案
- 后端新增 `POST /api/tools/knowledge-graph`
- 从 ChromaDB 获取当前书所有章节
- 调用 AI 为每章筛选 2-3 段关键原文
- 整合已有章节摘要、关键词、对话精华
- 生成一个自包含的 HTML 文件（内联 CSS）
- 卡片风格：黑白 zinc 色系，每章一张卡片
- 每章卡片包含：摘要 → 关键词 → 原文摘录 → AI 批注 → 笔记空白区
- 末尾附录：核心概念索引 + 推荐书单

### 改动文件
- `backend/app/routers/tools.py` — 新增 knowledge-graph 工具
- 无需前端改动（复用现有工具的调用流程，结果返回 HTML 内容触发下载）
