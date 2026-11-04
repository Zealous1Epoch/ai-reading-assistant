# 智能读书助手

基于公司内部部署大模型（OpenAI 兼容协议，vLLM）的智能读书助手，支持 PDF、TXT、EPUB 格式书籍的智能问答和总结。

## 页面与使用（v2.0 两级结构）

- **书架首页（`#/`）**：设计感封面网格（书名/作者排版 + 哈希配色），显示每本书"读到 ×章"进度；顶部全局语义搜索直达章节；整页拖拽上传新书；「复习」按钮（带今日到期数角标）进入复习页。
- **复习页（`#/review`）**：知识卡片翻卡复习——按书筛选，今日到期队列或随机测验；正面回忆、翻开对照，按"忘了/记住了/很熟"三档评分驱动 Leitner 间隔重复（1/2/4/7/15 天）。
- **书内三区（`#/book/{id}`）**：`[目录侧栏 | 阅读区 | AI 区]`，目录侧栏与 AI 区可独立收起（收为 36px 图标细栏）；顶栏六个开关：目录（侧栏开合） / 会话（抽屉） / AI / 卡片（抽屉） / 工具 / 资产（抽屉）。
  - **目录侧栏**：常驻左栏，章节树 + 本书全文搜索 + 书籍摘要，点章直达阅读区；可收起为细栏。
  - **会话抽屉**（顶栏「会话」，按钮带计数角标）：历史会话列表（时间/条数/专家徽标）、新建（自动收起抽屉）、切换、删除。
  - **阅读区**：正文在宽屏（AI 区收起、容器 ≥900px）自动双栏排版，像翻书一样；章头带字数、上一章/下一章翻页与**「听本章」**（整章转 mp3 朗读，后台合成、完成后播放条出现；换章不中断、再听秒播）。
  - **AI 区**：对话与工具产出统一时间线（工具结果是 `kind=tool` 消息卡片，可直接追问），SSE 流式输出，来源芯片逐条标注；回答句内带 `[n]` 引用角标（编号对应本轮参考段落），点击角标跳进原文对应章节并在该段落上闪烁高亮。
  - **工具抽屉**（顶栏「工具」）：带标题与范围切换（当前章 / 整本书），7 个 AI 工具（总结 / 读书十问 / 思维导图 / 与作者对谈 / 精读笔记 / 知识卡片 / **读书播客**）逐行显示名称和说明，点击即跑、产出并入对话流；读书播客先选主题与 10/20/30 分钟时长档。
  - **卡片抽屉**（顶栏「卡片」，按钮带该书今日到期数角标）：本书今日复习队列 / 随机测验 / 卡片列表（盒位与下次复习日、hover 删除），一键导出 Anki 可导入的 TSV。
  - **资产区抽屉**（顶栏「资产」，按钮带计数角标）：收藏全面后端化、按书归属（换设备不丢）。三类资产——文字（问答收藏/摘录）、AI 产出（工具结果，思维导图可**树形重放**并跳章、精读笔记 HTML 可**沙箱预览**）、报告（专家收束报告归档）。类型筛选 + 关键词搜索 + 展开复制/下载 + hover 移除 + 一键导出 Markdown。旧的浏览器 localStorage 收藏在首次进书时自动迁移到后端（全部成功才清旧 key，失败条目留着重试）。
- 阅读进度、界面开合状态存 localStorage；对话历史与本书资产按书隔离持久化在后端，刷新自动恢复。

## 核心功能

### 1. 智能书籍解析
- 支持 PDF、EPUB、TXT 格式（上传时做扩展名白名单 + 文件头魔数校验，伪装文件直接拒收）
- **EPUB 优先原生目录切分**：读取 NCX/nav 目录精确切章，零 AI 成本；无目录时降级 AI 辅助切分
- **AI 辅助章节切分**：提取前5000字让大模型识别目录结构，智能切分章节
- TXT 编码自动探测（UTF-8 / GB18030 / Big5 / Shift_JIS）
- **内容去重**：上传即计算 SHA-256，重复内容返回已有书籍，不产生冗余文件
- 每个章节包含：标题、内容、字数、章节索引

### 2. 向量化存储（RAG）
- **中文 embedding**：本地 ONNX 推理 `bge-small-zh-v1.5`（首次使用前运行 `python scripts/download_embedding_model.py` 下载模型，数据不出机器）
- 章节按 650 字**滑窗切块**（重叠 130 字）存入 **ChromaDB**（cosine 空间），检索命中即返回完整语义块
- 距离阈值过滤无关内容，问答上下文附带来源章节引用

### 3. 智能搜索
- 语义搜索：理解查询意图（如"主角的冒险经历"），不依赖关键词字面命中
- 全文搜索：精确关键词定位，按章聚合去重
- 章节定位：快速定位相关内容

### 4. 知识卡片与间隔重复（v2.3）
- **抽卡**：「知识卡片」工具从当前章（≤8 张）或全书（每 8 章一组 3 张、封顶 40 张）提炼概念卡（问题/答案/原文引证），产出即入库，同书内按问题去重
- **Leitner 五盒**：复习间隔 1/2/4/7/15 天；评分"忘了"回第 1 盒、"记住了"+1 盒、"很熟"+2 盒；新卡当天即到期
- **复习入口**：书架「复习」进全屏复习页（全库/按书、到期队列/随机测验）；书内「卡片」抽屉复习本书；数据存 `data/cards.json`，删书级联清理
- **Anki 导出**：`/cards/export/anki` 返回"正面/背面/书名标签"TSV，Anki 桌面版文本导入直用

## 项目结构

```
智能读书助手/
├── backend/              # FastAPI 后端
│   └── app/
│       ├── main.py       # 应用入口
│       ├── config.py     # 配置管理
│       ├── models/       # 数据模型
│       │   ├── schemas.py        # API请求/响应模型
│       │   └── book_models.py    # 书籍相关模型
│       ├── routers/      # API 路由
│       │   ├── chat.py           # 聊天接口
│       │   ├── books.py          # 书籍上传管理
│       │   ├── book_processor.py # 书籍处理分析
│       │   └── search.py         # 智能搜索
│       └── services/     # 业务服务
│           ├── ai_service.py       # AI 服务（内部部署模型）
│           ├── document_service.py # 文档处理服务
│           └── book_processor.py   # 书籍解析核心模块
├── frontend/             # Vite + React 18 + Tailwind 前端（hash 路由：#/ 书架、#/book/{id} 书内；dist 随仓库提交）
├── uploads/              # 上传的书籍文件
├── data/                 # 数据库文件（ChromaDB）
├── .env.example          # 环境变量模板
└── requirements.txt      # Python 依赖
```

## 快速体验 Demo

无需启动服务，一行命令运行完整流水线：

```bash
python demo.py                              # 使用内置 AI 科普样书
python demo.py your_book.pdf                # 使用你自己的 PDF/EPUB/TXT
```

Demo 会依次演示：文本提取 → AI 目录识别 → 置信度打分切分 → ChromaDB 存储 → 语义搜索。
输出 12 个章节和 3 组搜索示例。

## 快速开始

### 1. 配置环境

```bash
# 复制环境变量模板
cp .env.example .env

# 编辑 .env 文件，指向公司内部部署模型（OpenAI 兼容端点，向管理员索取 key）
# DEEPSEEK_API_KEY=<内部模型 key>
# DEEPSEEK_BASE_URL=http://<内部端点>/v1
# DEEPSEEK_MODEL=qwen3.8-flash-next
# 变量名保留 DEEPSEEK_ 前缀（历史兼容）；推理模型须在代码侧经
# chat_template_kwargs 关思考，见 analysis_service.py 注释
```

### 2. 安装依赖

```bash
# 创建虚拟环境（推荐）
python3 -m venv venv
source venv/bin/activate  # Linux/Mac

# 安装依赖
pip install -r requirements.txt
```

### 3. 启动后端服务

```bash
cd backend
python -m app.main
```

服务将在 `http://localhost:8000` 启动。

### 4. 访问 API 文档

- Swagger UI: http://localhost:8000/docs
- ReDoc: http://localhost:8000/redoc

## API 接口

### 书籍处理
- `POST /books/upload-and-analyze` - 上传并分析书籍（推荐）
- `POST /books/analyze-sync/{book_id}` - 同步分析已上传书籍
- `GET /books/analysis/{book_id}` - 获取分析结果
- `GET /books/{book_id}/chapters` - 获取所有章节
- `GET /books/chapters/{chapter_id}` - 获取单个章节内容

### 智能搜索
- `GET /search/chapters?query=关键词` - 搜索章节内容
- `GET /search/semantic?query=语义查询` - 语义搜索

### 聊天
- `POST /chat/` - 与 AI 助手对话
- `POST /analysis/chat/stream` - 流式对话（SSE；带 `session_id` 时问答自动持久化到会话；`expert_id` 指定专家人格换轨，会话已绑定专家时可省略）
- **句内引用（v2.2）**：RAG 命中时在上下文中给参考段落编号（当前章=1，检索块顺延），`sources` 帧每条带 `index`（对应 `[n]`）与 `snippet`（块体剥滑窗重叠前缀后的首行锚点，供前端段落级定位）；有来源时 system 末尾注入引用编号规则（编号每轮重分配，历史旧编号不沿用），默认人格与专家 override 一致生效

### 对话历史
- `GET /sessions?scope=book&book_id=` - 会话列表（按更新时间倒序）
- `POST /sessions` - 新建会话
- `GET /sessions/{session_id}` - 会话详情（含全部消息与来源）
- `DELETE /sessions/{session_id}` - 删除会话（删书时级联清理）

### AI 工具（SSE 流式）
- `POST /api/tools/{tool_id}/stream` - 运行工具，SSE 帧协议：`{"status"}` 进度 / `{"content"}` 正文增量 / `{"sources"}` 引用章节 / `{"artifact"}` HTML 产物 / `[DONE]`
- 请求体：`book_id` 必填；`chapter_id` 传了则作用范围为该章，否则整本书（工具抽屉顶部可切换）；`user_input` 仅 `author-talk`（读者的问题）与 `podcast`（本期主题）使用；`minutes` 仅 `podcast` 使用（10/20/30）
- 工具：`summarize` 总结（全书走 map-reduce 全章覆盖）、`questions` 读书十问、`mindmap` 思维导图（JSON 结构树，见下）、`author-talk` 与作者对谈（语义检索书中论点 grounding）、`knowledge-graph` 精读笔记（HTML 产物）、`cards` 知识卡片（提炼问题/答案/原文引证卡，产出即入复习库，见「知识卡片」节）、`podcast` 读书播客（双主播台本 + edge-tts 合成，见「听书与播客」节）
- **思维导图（v2.1）**：产出 `artifact {type:"mindmap", data:节点 JSON}`，节点 `{t:标题, c:子节点, cid:章节id}`。全书范围按 8 章/组生成三级骨架（书→章→主题），章节点由服务端按真实目录组装——结构性零漏章；单章一次生成四级树（章→主题→论点→论据）。前端自绘可折叠树：点章名跳原文、章节点可「展开详分支」
- `POST /api/tools/mindmap/expand/stream` - 章节按需展开：请求 `{book_id, chapter_id}`，按该章全文生成深层子树，SSE 返回 `artifact {type:"mindmap-subtree"}`；章节不存在 404
- LLM 输出上限经 `extra_body {"max_tokens":8192, "chat_template_kwargs":{"enable_thinking":false}}` 透传（langchain-openai 1.x 会把 max_tokens 改名成端点不认的键，导图漏章根因之一；bind 的 extra_body 整体替换构造器值，故内部 vLLM 必需的关思考参数必须在此一并带上）
- 背景调研 / 书籍推荐已下线（泛化搜索类，不基于馆藏内容，与读书助手定位弱相关）

### 知识卡片（v2.3）
- `GET /cards?book_id=` - 卡片列表（不传=全库）
- `GET /cards/due?book_id=` - 到期复习队列（难卡低盒优先）
- `GET /cards/stats` - 全库与按书 total/due（书架与顶栏徽标）
- `POST /cards/{card_id}/grade` - 复习评分 `{result: again|good|easy}` → Leitner 移盒重排期
- `DELETE /cards/{card_id}` - 删除卡片（删书时按书级联清理）
- `GET /cards/export/anki?book_id=` - Anki 导入用 TSV（正面/背面/书名标签）
- 抽卡入口 = AI 工具 `cards`（`POST /api/tools/cards/stream`，artifact `{type:"cards"}`，产出即入库）

### 听书与播客（v2.5）
语音全部走 edge-tts（微软在线神经网络语音，免费、无需 key，**不占内部模型算力**）；成品按内容哈希落盘 `data/audio/`，重复请求秒回缓存。
- `POST /audio/chapter` `{book_id, chapter_id}` - 整章听书：已缓存返回 `{status:"done", url, cached:true}`，否则建后台任务返回 `{task_id}`
- `GET /audio/task/{task_id}` - 任务轮询：`{status: running|done|error, progress | url | error}`
- `GET /audio/file/{name}` - mp3 流（文件名限定 40 位 sha1 hex，防路径穿越）
- **读书播客 = AI 工具 `podcast`**（`POST /api/tools/podcast/stream`）：`user_input`=本期主题、`minutes`=10/20/30（按约 240 字/分钟定台本目标）；流程 = 语义检索书中相关段落 → LLM 写双主播交替台本 `{"lines":[{"s":"A"|"B","t":"台词"}]}` → 逐段双声合成 mp3 帧拼接 → SSE `artifact {type:"audio", data:播放地址}`；新成品自动归档进本书资产区（`output_type="audio"`，可点开重听），缓存复用不重复存
- 时长估算：edge-tts 合成远快于实时（实测 1537 字整章约 25 秒出 1.9MB / 33 分钟音频）

### 本书资产区（v2.4）
- `GET /assets?book_id=&type=&q=` - 资产列表（type=note|tool|report；q 匹配标题+正文；created_at 倒序；不传 book_id=全库）
- `POST /assets` - 新增资产 `{book_id, type, content, title?, tool_id?, tool_name?, output_type?(text|html|mindmap|cards), source?}`（正文空/未知类型 400）
- `DELETE /assets/{asset_id}` - 移除单条资产（删会话不清资产——资产是归档语义；删书级联清理）
- `GET /assets/export?book_id=&ids=` - 导出 Markdown（ids 逗号分隔选子集，否则按书全量；空库 404）
- 前端收藏入口：AI 回答旁「收藏此问答」、工具卡「收藏结果」（思维导图/HTML 产出同样可藏）、报告卡「归档报告」；旧 localStorage 收藏进书时自动 POST 迁移

### 专家模式
专家 = 有完整读书方法论的角色（起手式 + 回合规则 + 收束报告三要素），区别于一次性工具：方法论主导多轮回路，读者做认知工作。

- `GET /experts` - 专家列表（展示元数据：花名/职业/方法论/标签/试试这样问；提示词不外发）
- `POST /experts/{expert_id}/opening` - 进入专家模式：按当前范围（`book_id` + 可选 `chapter_id`）生成第一回合并建会话（返回 `session_id`、`content`、`quick_prompts`；消息落盘 `kind:"opening"`）
- `POST /experts/{expert_id}/report` - 收束报告：读取会话全程，SSE 流式生成该专家方法论的认知诊断，完成后落盘 `kind:"report"`（会话无读者回答时 400）
- 专家包为文件化注册：`backend/app/experts/<expert_id>.json`，落文件即生效（每次读取热扫描），缺方法论字段拒绝加载
- 内置三位：`socrates` 苏格拉底（产婆术·只问不答）、`feynman` 费曼（学习检验·你讲他挑）、`munger` 芒格（反过来想·跨学科压力测试）

## 使用示例

### 上传并分析书籍

```bash
curl -X POST "http://localhost:8000/books/upload-and-analyze" \
  -H "Content-Type: multipart/form-data" \
  -F "file=@your_book.pdf"
```

### 搜索章节

```bash
# 关键词搜索
curl "http://localhost:8000/search/chapters?query=主角&page=1"

# 语义搜索
curl "http://localhost:8000/search/semantic?query=关于爱情的描写"
```

## 部署到 Linux 服务器

### 使用 Systemd 服务

```bash
# 创建服务文件
sudo nano /etc/systemd/system/book-assistant.service
```

```ini
[Unit]
Description=智能读书助手
After=network.target

[Service]
User=your_user
WorkingDirectory=/path/to/智能读书助手/backend
Environment="PATH=/path/to/智能读书助手/venv/bin"
ExecStart=/path/to/智能读书助手/venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
# 启动服务
sudo systemctl daemon-reload
sudo systemctl start book-assistant
sudo systemctl enable book-assistant
```

### 使用 Nginx 反向代理

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## 开发计划

- [x] 后端 API 框架
- [x] 智能章节切分（AI辅助）
- [x] ChromaDB 向量化存储
- [x] 语义搜索功能
- [ ] 前端界面（React + Tailwind CSS）
- [ ] 用户认证系统
- [ ] 读书笔记功能
- [ ] RAG 检索增强生成
- [ ] 批量书籍分析

## 技术栈

- **后端**: FastAPI + Uvicorn
- **AI**: LangChain + 公司内部部署大模型（OpenAI 兼容 / vLLM）+ 本地 bge-small-zh 向量模型
- **文档处理**: PyMuPDF + EbookLib
- **向量数据库**: ChromaDB
- **前端**: React + Tailwind CSS（计划中）
