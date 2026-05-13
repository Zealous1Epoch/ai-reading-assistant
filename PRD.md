# 智能读书助手 — 产品需求文档 (PRD)

**版本**: 1.2 | **更新日期**: 2026-05-13 | **状态**: 开发中

---

## 1. 产品概述

### 1.1 产品定位

一款面向深度阅读者的 AI 辅助阅读工具，帮助用户高效理解和分析书籍内容。通过 AI 语义搜索、多模式对话、结构化分析工具，降低深度阅读的门槛。

### 1.2 核心价值

| 痛点 | 解决方案 |
|---|---|
| 书太厚，没时间精读 | AI 自动切分章节、生成摘要和关键词 |
| 读完后记不住要点 | 读书十问、思维导图、收藏夹沉淀核心内容 |
| 想对比多本书的观点 | 综合阅读模式，跨本书 RAG 语义搜索 |
| 缺乏批判性思考视角 | 芒格辩论法工具，跨学科正反辩论 |

### 1.3 目标用户

- 深度阅读者：每月阅读 3 本以上非虚构类书籍的人群
- 学生/研究者：需要快速理解多本学术著作的用户
- 职场人士：希望通过阅读提升认知但没有足够时间的群体

---

## 2. 功能需求

### 2.1 功能总览

```
智能读书助手
├── 书籍管理
│   ├── 上传（PDF / EPUB / TXT）
│   ├── 批量上传（并行处理）
│   ├── 删除
│   └── 列表持久化（重启不丢失）
├── 智能阅读
│   ├── AI 章节切分（目录识别 + 正则降级）
│   ├── 章节摘要 + 关键词
│   └── 展开/收起全文
├── 对话模式
│   ├── 📖 当前章节 — 基于当前章节内容回答
│   ├── 🌐 整本书 — RAG 搜索全书后回答
│   └── 📚 综合阅读 — 跨本书 RAG 对比分析
├── AI 工具
│   ├── 总结 — 整本书或指定章节详细总结
│   ├── 背景调研 — 探索书籍的时代与学术背景
│   ├── 读书十问 — 十个深度问题吃透一本书
│   ├── 思维导图 — 六级深度可视化知识框架 (markmap + 全屏放大)
│   ├── 书籍推荐 — 推荐同主题好书
│   ├── 芒格辩论 — 跨学科正反辩论
│   └── 知识图谱 — 导出精读笔记 HTML 卡片页（章节摘要+摘录+关键词索引）
├── 收藏夹
│   ├── 收藏问答对 + AI 工具结果（localStorage 持久化）
│   ├── 工具结果类型标签（区分来源）
│   ├── 导出选中（TXT 格式）
│   └── 内容去重
└── 增强功能
    ├── 全文关键词搜索（章节内精确定位）
    ├── 层级目录 TOC（编号章节+缩进子节）
    ├── 扫描版 PDF OCR 进度反馈
    └── 上传→分析→轮询异步处理链路
```

### 2.2 详细功能描述

#### P0 — 核心功能

**书籍上传与解析**
- 支持 PDF、EPUB、TXT 三种格式，拖拽上传
- AI 辅助目录识别：提取前 5000 字调用 DeepSeek 识别章节结构，返回层级 TOC
- 正则降级方案：AI 失败时自动切换正则全文扫描（含去重、目录区/正文区分）
- 扫描版 PDF 自动降级到 Tesseract OCR（可选依赖），支持实时进度反馈（页数/总数）
- 异步处理链路：上传 → 异步分析 → 轮询状态（含 OCR 进度）
- 批量上传支持，部分失败不阻塞
- 章节内容自动清洗：移除 PDF 噪声、CIP 数据、乱码行

**三模式对话**
- 当前书籍模式：基于当前整本书内容回答（ChromaDB 语义搜索 top-5 章节）
- 综合阅读模式：跨本书 RAG 搜索对比，左侧勾选多本书
- SSE 流式输出 + 来源章节标注（含书名，可点击跳转）
- 对话历史按书籍隔离保存，模式切换独立

**AI 分析工具**
- 所有工具作用于当前选中的书籍，部分工具支持用户指定范围
- 需要输入的工具（总结、芒格辩论、思维导图）先显示输入框
- 思维导图：AI 生成六级深度 Markdown 层级结构（书名→章节→主题→论点→论据→具体引文/数据），markmap 交互式渲染，支持全屏悬浮放大
- 知识图谱：AI 生成结构化精读笔记 → 后端组装完整 HTML 页面（章节卡片+原文摘录+AI批注+关键词索引+书籍推荐），支持下载和预览
- 结果渲染：Markdown 表格→列表、编号/标题按卡片切分、bullet 层级渲染

#### P1 — 重要功能

**收藏夹**
- 对话中点击书签按钮收藏 Q&A，工具结果也可收藏
- 工具收藏显示类型标签（总结/读书十问/背景调研等）
- 内容去重（相同 question + answer 不重复收藏）
- 多选 + 导出为 TXT（区分聊天问答和 AI 工具来源）
- localStorage 持久化

**思维导图**
- AI 生成六级深度 Markdown 层级结构
- markmap 库渲染为交互式思维导图（可缩放、折叠节点）
- 全屏悬浮弹窗放大（毛玻璃背景 + 白卡片）
- 前后端双重清洗 AI 前言废话

**知识图谱**
- AI 生成结构化精读笔记（章节摘要+关键词+原文摘录+AI批注）
- 后端解析 AI 返回并组装完整锌色系 HTML 页面
- 含核心概念索引和书籍推荐附录
- 支持 iframe 预览 + 下载 HTML 文件
- 每章预留「我的笔记」手写区域（横线纸风格）

**全文搜索**
- 关键词精确定位，支持多章节匹配
- 显示关键词所在章节标题和上下文片段
- 搜索结果可直接点击跳转到对应章节

**层级目录 TOC**
- 点击书名后展示 AI 识别的层级目录结构
- 一级章节显示编号序号，二级小节缩进+圆点标记
- 当前章节高亮

#### P2 — 体验增强

- 来源标注可点击跳转到对应章节
- 上传拖拽支持
- 删除书籍确认弹窗
- OCR 进度实时反馈（进度条+页数）
- 章节内容 PDF 噪声自动清洗
- 阅读进度持久化（章节定位恢复）

---

## 3. 技术架构

### 3.1 整体架构

```
┌─────────────────────────────────────────────────────┐
│                   浏览器 (Frontend)                    │
│  React 18 + Babel Standalone + Tailwind CSS (CDN)    │
│  LeftPanel | MiddlePanel | RightPanel                │
└─────────────────────┬───────────────────────────────┘
                      │ HTTP / SSE
┌─────────────────────▼───────────────────────────────┐
│                FastAPI Backend                        │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐              │
│  │ books    │ │ analysis │ │ tools    │              │
│  │ router   │ │ router   │ │ router   │              │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘              │
│       │            │            │                     │
│  ┌────▼────────────▼────────────▼─────┐              │
│  │         Service Layer              │              │
│  │  book_processor | analysis_service │              │
│  └────┬───────────┬──────────┬───────┘              │
│       │           │          │                       │
│  ┌────▼───┐ ┌────▼────┐ ┌───▼────────┐              │
│  │ChromaDB│ │DeepSeek │ │ Local Disk │              │
│  │(向量)  │ │  API    │ │ (文件+JSON) │              │
│  └────────┘ └─────────┘ └────────────┘              │
└─────────────────────────────────────────────────────┘
```

### 3.2 前端架构

| 层次 | 技术选型 | 说明 |
|---|---|---|
| 框架 | React 18 | 通过 CDN 引入 umd 包 |
| 编译 | Babel Standalone | 浏览器端编译 JSX，无构建步骤 |
| 样式 | Tailwind CSS | CDN 引入 |
| 组件 | 4 个文件 | LeftPanel / MiddlePanel / RightPanel / App |

**组件职责**：
- `LeftPanel` — 来源列表、章节导航、上传区域
- `MiddlePanel` — 章节内容展示、对话消息、输入框
- `RightPanel` — AI 工具卡片、工具结果渲染、收藏夹
- `App` — 全局状态管理、API 调用、数据流协调

### 3.3 后端架构

| 层次 | 技术 | 说明 |
|---|---|---|
| Web 框架 | FastAPI + Uvicorn | 异步高性能 |
| AI | LangChain + DeepSeek API | OpenAI 兼容协议 |
| 向量库 | ChromaDB | 持久化到 `data/chroma_db` |
| OCR | Tesseract（可选） | 扫描版 PDF 降级方案 |
| 持久化 | JSON 文件 + ChromaDB | `data/books_index.json` 存书籍元信息 |

### 3.4 数据流

```
上传流程（异步三阶段）:
  Phase 1: 用户选择文件 → FormData → POST /books/upload
  → 保存文件到 uploads/ → 立即返回 {book_id, filename, format}
  Phase 2: POST /books/analyze/{book_id} → BackgroundTasks 异步分析
  → 提取文本 → AI 识别目录 / 正则降级 → 按目录切分章节
  → 内容清洗（PDF噪声/CIP/乱码）→ 存储到 ChromaDB
  → 写入 books_index.json
  Phase 3: 前端轮询 GET /books/status/{book_id}
  → 返回 {status, ocr_progress: {current, total, filename}}
  → status=completed 时 GET /books/analysis/{book_id} 获取结果

对话流程:
  用户输入 → POST /analysis/chat/stream
  ├─ 当前书籍: ChromaDB 语义搜索 top-5 章节
  └─ 综合阅读: ChromaDB 跨书搜索（selected_book_ids）
  → AI 流式生成 → SSE data: {...content...}
  → 末尾 data: {...sources...}（含书名+章节名）→ data: [DONE]

工具流程:
  用户输入范围 → POST /api/tools/{tool_id}
  → 从 ChromaDB 获取章节内容 → 按范围筛选章节
  → 组装 context + prompt → AI 生成 → 返回结果
  特殊工具:
  ├─ 思维导图: 前端 markmap 渲染 + 前后端清洗 AI 前言
  └─ 知识图谱: 后端解析结构化文本 → 组装 HTML → 返回 {data, type: 'html', filename}
```

---

## 4. UI/UX 设计规范

### 4.1 设计语言 — 极简黑白艺术风

- **色彩**：仅使用 zinc 色系（`zinc-50` 到 `zinc-900`），禁止任何彩色
- **容器**：`bg-white rounded-3xl border border-zinc-200`，`bg-zinc-50` 作为背景
- **按钮**：统一 `rounded-full` 胶囊形
- **字体**：标题使用 `Noto Serif SC` 衬线体，正文使用 `Inter` 无衬线体
- **间距**：主容器 `p-3 gap-3`，卡片内容 `px-4 pt-4 pb-2`，呼吸感
- **高亮**：`bg-zinc-50 ring-zinc-200`，禁用有彩色高亮

### 4.2 布局

```
┌─────────────┬──────────────────────────┬─────────────┐
│  LeftPanel  │      MiddlePanel         │ RightPanel  │
│  w-72       │      flex-1              │   w-80      │
│             │                          │             │
│  来源列表    │   章节内容 / 对话         │  AI 工具卡片 │
│  章节导航    │   输入框 + 模式切换       │  收藏夹      │
└─────────────┴──────────────────────────┴─────────────┘
```

### 4.3 工具结果渲染规则

- Markdown 表格 → 自动转为要点列表
- `**bold**` → `<strong>`，清除残余 `*` `#` 符号
- 编号/标题行 → 卡片模式：标题头 + 分隔线 + 正文区
- bullet 层级：顶层 `·` (U+00B7)，缩进 `◦` (U+25E6)
- 正文段：首行缩进两字

---

## 5. API 接口清单

### 书籍管理 (`/books`)

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/upload` | 上传文件（快速返回 book_id） |
| POST | `/analyze/{book_id}` | 异步分析（BackgroundTasks） |
| GET | `/status/{book_id}` | 获取处理状态（含 OCR 进度） |
| GET | `/analysis/{book_id}` | 获取分析结果 |
| GET | `/list` | 获取全部书籍列表 |
| GET | `/chapters/{chapter_id}` | 获取章节内容 |
| DELETE | `/{book_id}` | 删除书籍 |

### AI 分析 (`/analysis`)

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/chat/stream` | 流式对话 SSE（支持 book_id + selected_book_ids） |
| POST | `/chat` | 非流式对话（备用） |
| GET | `/chapter/{id}/summary` | 章节摘要 + 关键词 |
| POST | `/chapter/{id}` | 深度分析 |
| POST | `/quick` | 快速分析 |

### AI 工具 (`/api/tools`)

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/{tool_id}` | 运行指定工具（summarize/background/questions/mindmap/recommend/debate/knowledge-graph） |

### 搜索 (`/search`)

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/fulltext` | 全文关键词精确搜索 |
| GET | `/chapters` | 语义向量搜索 |
| GET | `/semantic` | 语义搜索（理解查询意图） |

---

## 6. 数据模型

### BookAnalysisResult
```python
book_id: str          # UUID
title: str            # 书名
author: Optional[str] # 作者
total_chapters: int   # 总章节数
total_words: int      # 总字数
chapters: List[Chapter]
toc: List[TocItem]
file_format: str      # PDF / EPUB / TXT
created_at: datetime
```

### Chapter
```python
chapter_id: str       # UUID
book_id: str
title: str            # 章节标题
content: str          # 正文
word_count: int
chapter_index: int
start_position: Optional[int]
end_position: Optional[int]
```

---

## 7. 已知约束与限制

### 技术限制
- 无构建步骤（Babel Standalone），不兼容 npm 生态
- API Key 存储在 `.env` 文件，不支持多用户
- OCR 依赖本地 Tesseract 安装，非默认可用
- ChromaDB 适用于单机部署，不支持分布式

### 性能边界
- 单本书上限建议 < 100MB / 1000 页
- ChromaDB 搜索限 top-5 章节，超出后上下文窗口不够
- 扫描版 PDF OCR 速度约 2-5 秒/页

---

## 8. 路线图

### v1.0 (已完成)
- [x] 基础上传解析（PDF/EPUB/TXT）
- [x] AI 章节切分 + 正则降级
- [x] ChromaDB 向量化存储
- [x] 三模式对话（当前书籍/综合阅读）
- [x] 六个 AI 分析工具
- [x] 收藏夹持久化
- [x] 极简黑白 UI
- [x] 批量上传（异步）
- [x] 书籍列表持久化

### v1.1 (已完成)
- [x] 扫描版 PDF OCR 进度反馈
- [x] 全文关键词搜索
- [x] 知识图谱 HTML 导出（章节卡片+摘录+索引）
- [x] 层级目录 TOC 展示
- [x] 思维导图全屏放大弹窗
- [x] 思维导图六级深度结构
- [x] AI 工具结果收藏
- [x] AI 前言清洗（前后端双重防护）

### v1.2 (当前)
- [ ] AI 工具流式输出（SSE）
- [ ] 阅读笔记/批注功能
- [ ] 阅读进度与位置追踪
- [ ] 对话历史管理

### v2.0 (未来)
- [ ] 双语阅读支持
- [ ] 移动端适配
- [ ] 笔记高亮功能

---

## 9. 竞品对比

| 特性 | 本产品 | ChatGPT + 上传 | 得到阅读器 | 微信读书 |
|---|---|---|---|---|
| 本地部署 | ✅ | ❌ | ❌ | ❌ |
| 章节切分 | ✅ AI 辅助 | ❌ | ❌ | ❌ |
| 多书对比 | ✅ | ❌ | ❌ | ❌ |
| 思维导图 | ✅ | 需手动 | ❌ | ❌ |
| 跨学科辩论 | ✅ | 需手动提示 | ❌ | ❌ |
| API Key 自备 | ✅ | ❌ | ❌ | ❌ |
| 免费 | ✅ API 按量付费 | $20/月 | 订阅制 | 免费 |
