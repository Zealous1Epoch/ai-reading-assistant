# 智能读书助手

基于 DeepSeek API 的智能读书助手，支持 PDF、TXT、EPUB 格式书籍的智能问答和总结。

## 核心功能

### 1. 智能书籍解析
- 支持 PDF、EPUB、TXT 格式
- **AI 辅助章节切分**：提取前5000字让 DeepSeek 识别目录结构，智能切分章节
- 每个章节包含：标题、内容、字数、章节索引

### 2. 向量化存储
- 使用 **ChromaDB** 存储章节向量
- 支持语义搜索，而非简单的关键词匹配

### 3. 智能搜索
- 语义搜索：理解查询意图（如"主角的冒险经历"）
- 章节定位：快速定位相关内容

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
│           ├── ai_service.py       # DeepSeek AI 服务
│           ├── document_service.py # 文档处理服务
│           └── book_processor.py   # 书籍解析核心模块
├── frontend/             # React 前端（待开发）
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

# 编辑 .env 文件，填入你的 DeepSeek API Key
# DEEPSEEK_API_KEY=your_api_key_here
# DEEPSEEK_MODEL=deepseek-chat
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
- **AI**: LangChain + DeepSeek API
- **文档处理**: PyMuPDF + EbookLib
- **向量数据库**: ChromaDB
- **前端**: React + Tailwind CSS（计划中）
